import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleHelp,
  Loader2,
  Play,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from './api';
import { roleLabels, type User } from '../../shared/domain';
import {
  helpProgressSchema,
  newHelpProgress,
  type HelpGuideId,
  type HelpProgress,
} from '../../shared/help';
import {
  contextualGuide,
  guidesForRole,
  helpQuestions,
  stepsForGuide,
  type HelpGuide,
  type HelpStep,
} from './help-content';

type TourStep = HelpStep & { guide: HelpGuide };
type Tour = {
  steps: TourStep[];
  index: number;
  full: boolean;
  orderId: string | null;
  preserveModal: boolean;
  returnRoute: string;
};
type Props = {
  user: User;
  route: string;
  requested: number;
  modalType?: string;
  navigate: (route: string) => void;
  open: (type: string) => void;
  close: () => void;
  menu: (open: boolean) => void;
};
const selector = (target: string) => `[data-help="${target}"]`;
function findVisible(query: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(query)).find(
      (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
    ) || null
  );
}
function waitFor(query: string, signal: AbortSignal): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (element: HTMLElement | null) => {
      observer.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(element);
    };
    const check = () => {
      const el = findVisible(query);
      if (el) finish(el);
    };
    const observer = new MutationObserver(check);
    const abort = () => finish(null);
    if (signal.aborted) {
      resolve(null);
      return;
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-help'],
    });
    timer = setTimeout(() => finish(null), 4500);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}
function readCache(key: string): { value: HelpProgress; pending: boolean } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    const parsed = helpProgressSchema.safeParse(cached?.value);
    return parsed.success ? { value: parsed.data, pending: cached.pending === true } : null;
  } catch {
    return null;
  }
}
function cache(key: string, value: HelpProgress, pending: boolean) {
  try {
    localStorage.setItem(key, JSON.stringify({ value, pending }));
  } catch {
    /* Help also works when browser storage is unavailable. */
  }
}

export function HelpSystem({
  user,
  route,
  requested,
  modalType,
  navigate,
  open,
  close,
  menu,
}: Props) {
  const cacheKey = `looma.help.v1.${user.id}.${user.role}`;
  const [progress, setProgress] = useState<HelpProgress>(
    () => readCache(cacheKey)?.value || newHelpProgress(),
  );
  const progressRef = useRef(progress);
  const [loaded, setLoaded] = useState(false),
    [mode, setMode] = useState<'welcome' | 'hub' | 'tour' | null>(null),
    [tab, setTab] = useState<'guides' | 'faq'>('guides'),
    [query, setQuery] = useState(''),
    [tour, setTour] = useState<Tour | null>(null),
    [preparing, setPreparing] = useState(false),
    [target, setTarget] = useState<HTMLElement | null>(null),
    [syncError, setSyncError] = useState(''),
    [startError, setStartError] = useState('');
  const [position, setPosition] = useState<{
    rect: { left: number; top: number; width: number; height: number } | null;
    left: number;
    top: number;
    width: number;
    side: 'above' | 'below' | 'center';
    arrow: number;
  }>({ rect: null, left: 16, top: 80, width: 360, side: 'center', arrow: 30 });
  const layer = useRef<HTMLDivElement>(null),
    card = useRef<HTMLElement>(null),
    introduced = useRef(false),
    lastRequest = useRef(requested),
    alive = useRef(true),
    saving = useRef(Promise.resolve()),
    controllers = useRef(new Set<AbortController>()),
    ownedModal = useRef(false),
    savedFocus = useRef<HTMLElement | null>(null);
  const [smallScreen, setSmallScreen] = useState(window.innerWidth <= 760);
  useEffect(() => {
    const resize = () => setSmallScreen(window.innerWidth <= 760);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const visible = mode !== null;
  const guides = guidesForRole(user.role);
  const settingsTab =
    document
      .querySelector('[data-help-tab^="settings:"].active')
      ?.getAttribute('data-help-tab')
      ?.split(':')[1] || 'company';
  const currentId = contextualGuide(route, modalType, settingsTab);
  const currentGuide = guides.find((g) => g.id === currentId) || guides[0];
  const current = tour?.steps[tour.index];
  const mobileSearch = smallScreen && current?.guide.id === 'workspace' && current.id === 'search';

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const controller of controllers.current) controller.abort();
    };
  }, []);
  const persist = useCallback(
    (value: HelpProgress) => {
      progressRef.current = value;
      setProgress(value);
      cache(cacheKey, value, true);
      saving.current = saving.current
        .catch(() => {})
        .then(async () => {
          if (!alive.current) return;
          const controller = new AbortController();
          controllers.current.add(controller);
          try {
            await patchWithSignal(value, controller.signal);
            if (alive.current) {
              if (progressRef.current === value) cache(cacheKey, value, false);
              setSyncError('');
            }
          } catch (error) {
            if (alive.current && !controller.signal.aborted)
              setSyncError(
                'Не удалось синхронизировать обучение. На этом устройстве можно продолжить.',
              );
          } finally {
            controllers.current.delete(controller);
          }
        });
    },
    [cacheKey],
  );
  useEffect(() => {
    const controller = new AbortController();
    api('/auth/help', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const remote = helpProgressSchema.parse(value),
          local = readCache(cacheKey);
        const next = local?.pending ? local.value : remote;
        progressRef.current = next;
        setProgress(next);
        cache(cacheKey, next, !!local?.pending);
        setLoaded(true);
        if (local?.pending) persist(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, [cacheKey, persist]);
  useEffect(() => {
    if (!loaded || introduced.current || mode || document.querySelector(selector('modal'))) return;
    introduced.current = true;
    if (['new', 'active'].includes(progressRef.current.status)) setMode('welcome');
  }, [loaded, mode, modalType]);
  useEffect(() => {
    if (requested === lastRequest.current) return;
    lastRequest.current = requested;
    introduced.current = true;
    setStartError('');
    setMode('hub');
  }, [requested]);

  const stop = useCallback(
    (reason: 'skip' | 'pause' | 'complete' | 'hub') => {
      const p = progressRef.current;
      if (reason === 'skip' && p.status !== 'completed')
        persist({ ...p, status: 'skipped', last_step: null });
      if (reason === 'complete' && tour?.full)
        persist({ ...p, status: 'completed', last_step: null });
      if (ownedModal.current) {
        close();
        ownedModal.current = false;
      }
      menu(false);
      setTarget(null);
      setPreparing(false);
      if (tour && !tour.preserveModal) navigate(tour.returnRoute);
      setTour(null);
      setMode(reason === 'hub' ? 'hub' : null);
    },
    [close, menu, navigate, persist, tour],
  );
  const dismiss = useCallback(() => {
    if (mode === 'tour') stop('pause');
    else {
      if (mode === 'welcome' && progressRef.current.status === 'new')
        persist({ ...progressRef.current, status: 'skipped' });
      setMode(null);
    }
  }, [mode, persist, stop]);

  useEffect(() => {
    if (!visible) return;
    const app = document.querySelector<HTMLElement>('[data-help-app]');
    const wasInert = app?.inert || false,
      before = document.body.style.overflow;
    savedFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    return () => {
      if (app) app.inert = wasInert;
      document.body.style.overflow = before;
      savedFocus.current?.focus({ preventScroll: true });
    };
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() =>
      layer.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }),
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = layer.current?.querySelector('[role="dialog"]');
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,summary,a[href],[tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length);
      const first = items[0],
        last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [visible, mode, current?.id, dismiss]);

  async function start(id?: HelpGuideId, resume = false) {
    setPreparing(true);
    setStartError('');
    const preserveModal = !!document.querySelector(selector('modal'));
    if (!id && preserveModal) {
      setPreparing(false);
      setStartError(
        'Сначала завершите открытую форму. Здесь можно пройти подсказки к этой форме, не закрывая её.',
      );
      return;
    }
    let selected = id ? guides.filter((g) => g.id === id) : guides.filter((g) => !g.contextOnly);
    if (preserveModal) selected = selected.filter((g) => g.id === currentGuide.id);
    if (!selected.length) {
      setPreparing(false);
      return;
    }
    let orderId = route.startsWith('orders/') ? route.split('/')[1] : null;
    if (selected.some((g) => g.order) && !orderId) {
      try {
        const result = await api<{ items: Array<{ id: string }> }>('/orders?scope=work&page=1');
        orderId = result.items[0]?.id || null;
        if (!orderId) {
          const archived = await api<{ items: Array<{ id: string }> }>(
            '/orders?scope=archive&page=1',
          );
          orderId = archived.items[0]?.id || null;
        }
      } catch {
        setPreparing(false);
        setStartError('Не удалось открыть заказы. Проверьте соединение и попробуйте ещё раз.');
        return;
      }
    }
    const steps: TourStep[] = selected.flatMap((guide) => {
      if (guide.order && !orderId)
        return [
          {
            guide,
            id: 'empty',
            title: 'Карточка появится вместе с первым заказом',
            text: 'Пока доступных заказов нет. Когда появится первый заказ, откройте его: там будут производство, изделия и фото, документы и задачи. Подробное обучение карточке можно запустить здесь через знак вопроса.',
            target: 'orders',
          },
        ];
      return stepsForGuide(guide, user.role).map((step) => ({ ...step, guide }));
    });
    const found = resume
      ? steps.findIndex((step) => `${step.guide.id}.${step.id}` === progressRef.current.last_step)
      : -1;
    const index = found >= 0 ? found : 0;
    setTour({ steps, index, full: !id, orderId, preserveModal, returnRoute: route });
    setMode('tour');
    if (!id)
      persist({
        ...progressRef.current,
        status: 'active',
        last_step: `${steps[index].guide.id}.${steps[index].id}`,
      });
  }

  useEffect(() => {
    if (mode !== 'tour' || !tour || !current) return;
    const controller = new AbortController();
    setTarget(null);
    setPreparing(true);
    (async () => {
      if (!tour.preserveModal) {
        if (ownedModal.current && !current.guide.modal) {
          close();
          ownedModal.current = false;
        }
        const destination = mobileSearch
          ? 'orders'
          : current.guide.order
            ? tour.orderId
              ? `orders/${tour.orderId}`
              : 'orders'
            : current.guide.route;
        if (destination) navigate(destination);
        if (current.guide.modal && !current.guide.contextOnly) {
          open(current.guide.modal);
          ownedModal.current = true;
        }
      }
      const isSmall = smallScreen;
      menu(isSmall && current.target === 'navigation');
      if (current.tab && !tour.preserveModal) {
        const button = await waitFor(`[data-help-tab="${current.tab}"]`, controller.signal);
        if (controller.signal.aborted) return;
        button?.click();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }
      if (controller.signal.aborted) return;
      let query = selector(mobileSearch ? 'orders-filters' : current.target);
      if (tour.preserveModal) {
        const modal = findVisible(selector('modal'));
        const candidate = findVisible(query);
        if (!candidate || !modal?.contains(candidate)) query = selector('modal');
      }
      let element = await waitFor(query, controller.signal);
      if (controller.signal.aborted) return;
      if (!element && tour.preserveModal) element = findVisible(selector('modal'));
      element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      setTarget(element);
      setPreparing(false);
    })();
    return () => controller.abort();
    // Route changes and opening read-only tabs are effects of a step, not new steps.
  }, [mode, tour?.index, tour?.steps, smallScreen]);

  useLayoutEffect(() => {
    if (mode !== 'tour') return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.min(380, window.innerWidth - 32),
          height = card.current?.getBoundingClientRect().height || 300;
        const raw = target?.isConnected ? target.getBoundingClientRect() : null;
        const rect =
          raw && raw.width && raw.height
            ? {
                left: Math.max(8, raw.left - 5),
                top: Math.max(8, raw.top - 5),
                width: Math.max(
                  0,
                  Math.min(window.innerWidth - 8, raw.right + 5) - Math.max(8, raw.left - 5),
                ),
                height: Math.max(
                  0,
                  Math.min(window.innerHeight - 8, raw.bottom + 5) - Math.max(8, raw.top - 5),
                ),
              }
            : null;
        let left = (window.innerWidth - width) / 2,
          top = Math.max(16, (window.innerHeight - height) / 2),
          side: 'above' | 'below' | 'center' = 'center',
          arrow = width / 2;
        if (rect && rect.height > 0) {
          left = Math.max(
            16,
            Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 16),
          );
          if (rect.top + rect.height + height + 32 < window.innerHeight) {
            top = rect.top + rect.height + 18;
            side = 'below';
          } else if (rect.top > height + 32) {
            top = rect.top - height - 18;
            side = 'above';
          } else {
            top = Math.max(16, window.innerHeight - height - 16);
          }
          arrow = Math.max(22, Math.min(width - 22, rect.left + rect.width / 2 - left));
        }
        setPosition({
          rect,
          left,
          top: Math.max(16, Math.min(top, window.innerHeight - height - 16)),
          width,
          side,
          arrow,
        });
      });
    };
    const observer = new ResizeObserver(measure);
    if (target) observer.observe(target);
    if (card.current) observer.observe(card.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [mode, target, current, preparing]);

  function advance(delta: number) {
    if (!tour || !current || preparing) return;
    const next = tour.index + delta;
    let p = progressRef.current;
    if (
      delta > 0 &&
      (next === tour.steps.length || tour.steps[next].guide.id !== current.guide.id) &&
      !(current.guide.order && !tour.orderId)
    ) {
      p = { ...p, completed: [...new Set([...p.completed, current.guide.id])] };
      persist(p);
    }
    if (next >= tour.steps.length) {
      stop('complete');
      return;
    }
    if (tour.full)
      persist({
        ...p,
        status: 'active',
        last_step: `${tour.steps[next].guide.id}.${tour.steps[next].id}`,
      });
    setPreparing(true);
    setTarget(null);
    setTour({ ...tour, index: Math.max(0, next) });
  }
  if (!mode) return null;
  const modalOpen = !!modalType || !!document.querySelector(selector('modal'));
  const faq = helpQuestions
    .filter((item) => item.roles.includes(user.role))
    .filter((item) =>
      (item.question + ' ' + item.answer)
        .toLocaleLowerCase('ru')
        .replace(/ё/g, 'е')
        .includes(query.toLocaleLowerCase('ru').replace(/ё/g, 'е')),
    );
  return createPortal(
    <div
      ref={layer}
      className={
        'help-layer ' +
        (mode === 'tour' ? 'is-tour' : '') +
        (mode === 'tour' && target && !preparing ? ' with-spotlight' : '')
      }
      data-help-overlay="true"
    >
      {mode === 'tour' && position.rect && !preparing && (
        <div className="help-spotlight" style={position.rect} aria-hidden="true" />
      )}
      {mode === 'welcome' && (
        <section
          className="help-welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-welcome-title"
          aria-describedby="help-welcome-text"
          tabIndex={-1}
        >
          <button
            className="icon-btn help-close"
            onClick={dismiss}
            aria-label="Закрыть приветствие"
          >
            <X size={20} />
          </button>
          <div className="help-emblem">
            <Sparkles size={28} />
          </div>
          <span className="help-eyebrow">ДОБРО ПОЖАЛОВАТЬ В LOOMA.CRM</span>
          <h2 id="help-welcome-title">
            {progress.status === 'active' ? 'Продолжим знакомство?' : 'Освоимся в мастерской?'}
          </h2>
          <p id="help-welcome-text">
            Покажем, где вести заказы, находить задачи и работать с документами. Подсказки
            подготовлены для вашей роли: <b>{roleLabels[user.role].toLowerCase()}</b>.
          </p>
          <div className="help-welcome-note">
            <CircleHelp size={20} />
            <span>
              Экскурсия только показывает интерфейс. Её можно пропустить и в любой момент вернуть
              через знак вопроса.
            </span>
          </div>
          {startError && (
            <p role="alert" className="form-error">
              {startError}
            </p>
          )}
          <button
            className="btn primary full"
            disabled={preparing}
            onClick={() => void start(undefined, true)}
          >
            {preparing ? <Loader2 size={17} className="spin" /> : <Play size={17} />}{' '}
            {progress.status === 'active' ? 'Продолжить обучение' : 'Начать обучение'}
          </button>
          <button
            className="text-btn help-skip"
            onClick={() => {
              persist({ ...progressRef.current, status: 'skipped', last_step: null });
              setMode(null);
            }}
          >
            Пропустить обучение
          </button>
        </section>
      )}
      {mode === 'hub' && (
        <section
          className="help-hub"
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-hub-title"
          tabIndex={-1}
        >
          <div className="help-hub-heading">
            <div>
              <span className="help-eyebrow">ПОДСКАЗКИ ПОД РУКОЙ</span>
              <h2 id="help-hub-title">Помощь в LOOMA.CRM</h2>
              <p>{roleLabels[user.role]} · обучение по вашим рабочим разделам</p>
            </div>
            <button className="icon-btn" onClick={dismiss} aria-label="Закрыть помощь">
              <X size={21} />
            </button>
          </div>
          <div className="help-tabs">
            <button className={tab === 'guides' ? 'active' : ''} onClick={() => setTab('guides')}>
              <BookOpen size={17} />
              Обучение
            </button>
            <button className={tab === 'faq' ? 'active' : ''} onClick={() => setTab('faq')}>
              <CircleHelp size={17} />
              Частые вопросы
            </button>
          </div>
          <div className="help-hub-body">
            {tab === 'guides' ? (
              <>
                <div className="help-current">
                  <span className="help-module-icon">
                    <CircleHelp size={23} />
                  </span>
                  <div>
                    <small>СЕЙЧАС У ВАС ОТКРЫТО</small>
                    <h3>{currentGuide.title}</h3>
                    <p>{currentGuide.description}</p>
                    <button
                      className="btn primary"
                      disabled={preparing}
                      onClick={() => void start(currentGuide.id)}
                    >
                      <Play size={15} />
                      Показать этот раздел
                    </button>
                  </div>
                </div>
                {!modalOpen && (
                  <div className="help-full-tour">
                    <div>
                      <h3>Вся CRM по порядку</h3>
                      <p>
                        Экскурсия переключает разделы. Начните её после сохранения открытых форм.
                      </p>
                    </div>
                    <button
                      className="btn"
                      disabled={preparing}
                      onClick={() => void start(undefined, progress.status === 'active')}
                    >
                      {progress.status === 'active' ? 'Продолжить экскурсию' : 'Пройти экскурсию'}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )}
                {modalOpen && (
                  <p className="inline-note">
                    Подсказки к этой форме сохраняют введённые поля. Для экскурсии по другим
                    разделам сначала завершите форму.
                  </p>
                )}
                {startError && (
                  <p className="form-error" role="alert">
                    {startError}
                  </p>
                )}
                <h3 className="help-list-title">Обучение по разделам</h3>
                <div className="help-guide-list">
                  {guides
                    .filter((g) => !g.contextOnly)
                    .map((guide) => (
                      <button
                        key={guide.id}
                        disabled={preparing || (modalOpen && guide.id !== currentGuide.id)}
                        onClick={() => void start(guide.id)}
                      >
                        <span
                          className={
                            'help-guide-check ' +
                            (progress.completed.includes(guide.id) ? 'done' : '')
                          }
                        >
                          {progress.completed.includes(guide.id) ? (
                            <Check size={16} />
                          ) : (
                            <BookOpen size={16} />
                          )}
                        </span>
                        <span>
                          <b>{guide.title}</b>
                          <small>{guide.description}</small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <>
                <label className="help-search">
                  <Search size={18} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Например, фото, оплата или задача"
                    aria-label="Поиск по вопросам"
                  />
                </label>
                <div className="help-faq">
                  {faq.map((item) => (
                    <details key={item.id}>
                      <summary>{item.question}</summary>
                      <p>{item.answer}</p>
                      {!modalOpen && (
                        <button className="text-btn" onClick={() => void start(item.guide)}>
                          Показать в приложении <ArrowRight size={14} />
                        </button>
                      )}
                    </details>
                  ))}
                  {!faq.length && (
                    <p className="help-no-results">
                      По этому запросу ответов нет. Попробуйте другое слово или откройте обучение по
                      разделам.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
          {syncError && (
            <p className="help-sync" role="status">
              {syncError}{' '}
              <button className="text-btn" onClick={() => persist(progressRef.current)}>
                Повторить
              </button>
            </p>
          )}
        </section>
      )}
      {mode === 'tour' && current && tour && (
        <section
          ref={card}
          className={'help-step ' + (preparing || !position.rect ? 'is-centered' : '')}
          style={{ left: position.left, top: position.top, width: position.width }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="help-step-title"
          aria-describedby="help-step-text"
          tabIndex={-1}
          data-help-step={`${current.guide.id}.${current.id}`}
        >
          {!preparing && position.rect && position.side !== 'center' && (
            <span
              className={'help-arrow ' + position.side}
              style={{ left: position.arrow }}
              aria-hidden="true"
            />
          )}
          <div className="help-step-content">
            <div className="help-step-top">
              <span>{current.guide.title}</span>
              <button
                className="icon-btn"
                onClick={() => stop('pause')}
                aria-label="Закрыть обучение и сохранить место"
              >
                <X size={18} />
              </button>
            </div>
            <div
              className="help-progress"
              role="progressbar"
              aria-label="Прогресс обучения"
              aria-valuemin={0}
              aria-valuemax={tour.steps.length}
              aria-valuenow={tour.index + 1}
            >
              <i style={{ width: `${((tour.index + 1) / tour.steps.length) * 100}%` }} />
            </div>
            <span className="help-step-count">
              Шаг {tour.index + 1} из {tour.steps.length}
            </span>
            <h2 id="help-step-title">{current.title}</h2>
            <p id="help-step-text">
              {mobileSearch
                ? 'В разделе «Заказы» используйте поиск по номеру, имени клиента или изделию. Список обновляется по мере ввода.'
                : current.text}
            </p>
            {preparing && (
              <p className="help-wait" role="status">
                <Loader2 size={15} className="spin" />
                Показываем нужный блок…
              </p>
            )}
            {!preparing && !target && (
              <p className="help-wait">
                Блок пока не отображается. Можно продолжить и вернуться к нему позже.
              </p>
            )}
            {syncError && (
              <p className="help-sync" role="status">
                {syncError}
              </p>
            )}
            <div className="help-step-actions">
              <button
                className="btn"
                disabled={tour.index === 0 || preparing}
                onClick={() => advance(-1)}
              >
                <ArrowLeft size={15} />
                Назад
              </button>
              <button className="btn primary" disabled={preparing} onClick={() => advance(1)}>
                {tour.index === tour.steps.length - 1 ? 'Завершить' : 'Далее'}
                {tour.index === tour.steps.length - 1 ? (
                  <Check size={16} />
                ) : (
                  <ArrowRight size={16} />
                )}
              </button>
            </div>
            <div className="help-step-footer">
              <button className="text-btn" onClick={() => stop('skip')}>
                Пропустить обучение
              </button>
              <button className="text-btn" onClick={() => stop('hub')}>
                Все разделы
              </button>
            </div>
          </div>
        </section>
      )}
    </div>,
    document.body,
  );
}
function patchWithSignal(value: HelpProgress, signal: AbortSignal) {
  return api('/auth/help', { method: 'PATCH', body: JSON.stringify(value), signal });
}
