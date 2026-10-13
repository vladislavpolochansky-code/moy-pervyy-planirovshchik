(() => {
  'use strict';

  const STORAGE_KEY = 'personal-week-planner:v1';
  const MIN_DATE = '2000-01-01';
  const MAX_DATE = '2099-12-31';
  const DAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const pad = value => String(value).padStart(2, '0');
  const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const localDate = key => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
  };
  const addDays = (date, days) => {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    result.setDate(result.getDate() + days);
    return result;
  };
  const mondayOf = date => addDays(date, -((date.getDay() + 6) % 7));
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= MIN_DATE && value <= MAX_DATE && dateKey(localDate(value)) === value;
  const validStamp = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && dateKey(localDate(value.slice(0, 10))) === value.slice(0, 10)
    && Number.isFinite(Date.parse(value));
  const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
  const validDuration = value => Number.isInteger(value) && value >= 30 && value <= 1020 && value % 30 === 0;
  const isOverdue = (task, today) => !task.completed && task.deadlineDate !== null && task.deadlineDate < today;
  const blankState = () => ({ schemaVersion: 1, revision: 0, library: [], tasks: [], preferences: { hideCompleted: false }, savedAt: new Date().toISOString() });

  function validateState(input) {
    const fail = () => { throw new Error('invalid-state'); };
    if (!plainObject(input) || input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0
      || !Array.isArray(input.library) || !Array.isArray(input.tasks) || !plainObject(input.preferences)
      || typeof input.preferences.hideCompleted !== 'boolean' || !validStamp(input.savedAt)) fail();
    const ids = new Set();
    const common = entry => {
      if (!plainObject(entry) || !validId(entry.id) || ids.has(entry.id)
        || typeof entry.title !== 'string' || entry.title.trim().length < 1 || entry.title.length > 120
        || typeof entry.description !== 'string' || entry.description.length > 4000
        || !validDuration(entry.durationMinutes) || !validStamp(entry.createdAt) || !validStamp(entry.updatedAt)) fail();
      ids.add(entry.id);
      return { id: entry.id, title: entry.title, description: entry.description,
        durationMinutes: entry.durationMinutes, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    };
    const library = input.library.map(common);
    const libraryIds = new Set(library.map(entry => entry.id));
    const byDay = new Map();
    const tasks = input.tasks.map(entry => {
      const base = common(entry);
      if (!(entry.libraryId === null || validId(entry.libraryId)) || !['auto', 'manual'].includes(entry.deadlineMode)
        || !(entry.deadlineDate === null || validDate(entry.deadlineDate)) || typeof entry.completed !== 'boolean'
        || (entry.deadlineMode === 'manual' && !validDate(entry.deadlineDate))
        || !(entry.completedAt === null || validStamp(entry.completedAt))
        || (entry.completed ? entry.completedAt === null : entry.completedAt !== null)) fail();
      const inBuffer = entry.plannedDate === null && entry.startMinutes === null && entry.endMinutes === null;
      if (!inBuffer) {
        if (!validDate(entry.plannedDate) || !Number.isInteger(entry.startMinutes) || !Number.isInteger(entry.endMinutes)
          || entry.startMinutes < 360 || entry.startMinutes > 1350 || entry.endMinutes > 1380
          || entry.endMinutes <= entry.startMinutes || entry.startMinutes % 30 !== 0 || entry.endMinutes % 30 !== 0
          || entry.durationMinutes !== entry.endMinutes - entry.startMinutes || entry.deadlineDate === null
          || (entry.deadlineMode === 'auto' && entry.deadlineDate !== entry.plannedDate)) fail();
        if (!byDay.has(entry.plannedDate)) byDay.set(entry.plannedDate, []);
        byDay.get(entry.plannedDate).push(entry);
      } else if (entry.completed) fail();
      return { ...base, libraryId: libraryIds.has(entry.libraryId) ? entry.libraryId : null,
        plannedDate: entry.plannedDate, startMinutes: entry.startMinutes, endMinutes: entry.endMinutes,
        deadlineMode: entry.deadlineMode, deadlineDate: entry.deadlineDate,
        completed: entry.completed, completedAt: entry.completedAt };
    });
    for (const entries of byDay.values()) {
      entries.sort((a, b) => a.startMinutes - b.startMinutes);
      for (let i = 1; i < entries.length; i += 1) if (entries[i].startMinutes < entries[i - 1].endMinutes) fail();
    }
    return { schemaVersion: 1, revision: input.revision, library, tasks,
      preferences: { hideCompleted: input.preferences.hideCompleted }, savedAt: input.savedAt };
  }

  // Хранилище не изменяет основной ключ до явного подтверждённого действия.
  class Repository {
    constructor(storage) {
      this.storage = storage;
      this.state = blankState();
      this.raw = null;
      this.writable = false;
      this.valid = false;
      this.error = '';
    }
    probe() {
      const key = `${STORAGE_KEY}:probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      try {
        this.storage.setItem(key, '1');
        const available = this.storage.getItem(key) === '1';
        this.storage.removeItem(key);
        this.writable = available;
      } catch {
        this.writable = false;
        try { this.storage.removeItem(key); } catch { /* браузер может запрещать все операции */ }
      }
      return this.writable;
    }
    read() {
      try {
        const raw = this.storage.getItem(STORAGE_KEY);
        const next = raw === null ? blankState() : validateState(JSON.parse(raw));
        this.state = next;
        this.raw = raw;
        this.valid = true;
        this.error = '';
        return true;
      } catch {
        this.valid = false;
        this.error = 'Не удалось прочитать данные: хранилище недоступно или сохранённый формат некорректен. Исходные данные не изменены.';
        return false;
      }
    }
    write(candidate) {
      if (!this.writable || !this.valid) return { ok: false, reason: 'unavailable' };
      try {
        const actual = this.storage.getItem(STORAGE_KEY);
        if (actual !== this.raw) {
          this.read();
          return { ok: false, reason: 'conflict' };
        }
        if (this.state.revision >= Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'revision-limit' };
        const next = validateState({ ...candidate, revision: this.state.revision + 1, savedAt: new Date().toISOString() });
        const serialized = JSON.stringify(next);
        this.storage.setItem(STORAGE_KEY, serialized);
        this.state = next;
        this.raw = serialized;
        return { ok: true };
      } catch {
        return { ok: false, reason: 'save-failed' };
      }
    }
  }

  const $ = id => document.getElementById(id);
  let storage;
  try { storage = window.localStorage; } catch {
    storage = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); }, removeItem() { throw new Error('unavailable'); } };
  }
  const repository = new Repository(storage);
  repository.probe();
  repository.read();
  let todayKey = dateKey(new Date());
  const clampedToday = () => localDate(todayKey < MIN_DATE ? MIN_DATE : todayKey > MAX_DATE ? MAX_DATE : todayKey);
  let selectedMonday = mondayOf(clampedToday());
  let storageNotice = '';
  const dayViews = [];
  const fullDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const shortDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

  function createDay(index) {
    const heading = document.createElement('div');
    heading.className = 'day-heading';
    const label = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = DAY_NAMES[index];
    const date = document.createElement('span');
    date.className = 'day-date';
    label.append(name, date);
    const mark = document.createElement('span');
    mark.className = 'today-mark';
    heading.append(label, mark);
    const grid = document.createElement('div');
    grid.className = 'day-grid';
    const fragment = document.createDocumentFragment();
    for (let slot = 0; slot < 34; slot += 1) {
      const minutes = 360 + slot * 30;
      const row = document.createElement('button');
      row.tabIndex = -1; // Создание с клавиатуры доступно через общую форму.
      row.type = 'button'; row.dataset.action = 'create-slot';
      row.className = `time-slot${slot % 2 ? ' half-hour' : ''}`;
      row.dataset.minutes = String(minutes);
      row.textContent = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      fragment.append(row);
    }
    const end = document.createElement('span');
    end.className = 'end-time';
    end.textContent = '23:00';
    const line = document.createElement('div');
    line.className = 'current-time';
    line.hidden = true;
    line.setAttribute('aria-hidden', 'true');
    const layer = document.createElement('div'); layer.className = 'task-layer';
    grid.append(fragment, end, line, layer);
    dayViews.push({ heading, date, mark, grid, line, layer });
    if (index < 5) {
      $('workday-headings').append(heading);
      $('workday-grids').append(grid);
    } else {
      const section = document.createElement('section');
      section.className = 'weekend-day';
      section.setAttribute('aria-label', DAY_NAMES[index]);
      const scroll = document.createElement('div');
      scroll.className = 'weekend-scroll';
      scroll.id = index === 5 ? 'saturday-scroll' : 'sunday-scroll';
      scroll.tabIndex = 0;
      scroll.setAttribute('aria-label', `Прокрутка расписания: ${DAY_NAMES[index]}`);
      scroll.append(grid);
      section.append(heading, scroll);
      $('weekend').append(section);
    }
  }
  for (let index = 0; index < 7; index += 1) createDay(index);

  function updateClock(now = new Date()) {
    todayKey = dateKey(now);
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const view of dayViews) {
      const isToday = view.grid.dataset.date === todayKey;
      view.heading.classList.toggle('is-today', isToday);
      view.mark.textContent = isToday ? 'сегодня' : '';
      view.line.hidden = !isToday || minutes < 360 || minutes >= 1380;
      view.line.style.top = `${minutes - 360}px`;
    }
    const weekToday = dateKey(mondayOf(clampedToday()));
    $('week-context').textContent = dateKey(selectedMonday) === weekToday ? 'текущая неделя' : 'выбранная неделя';
  }

  function renderWeek() {
    $('week-range').textContent = `${fullDate.format(selectedMonday)} – ${fullDate.format(addDays(selectedMonday, 6))}`;
    for (let index = 0; index < 7; index += 1) {
      const date = addDays(selectedMonday, index);
      const key = dateKey(date);
      const view = dayViews[index];
      view.date.textContent = shortDate.format(date);
      view.grid.dataset.date = key;
      view.grid.setAttribute('aria-label', `${DAY_NAMES[index]}, ${fullDate.format(date)}, расписание`);
      view.grid.classList.toggle('outside-range', key < MIN_DATE || key > MAX_DATE);
    }
    $('previous-week').disabled = dateKey(addDays(selectedMonday, -1)) < MIN_DATE;
    $('next-week').disabled = dateKey(addDays(selectedMonday, 7)) > MAX_DATE;
    updateClock();
    renderTasks();
    renderReports();
  }

  function renderStorage(message) {
    if (message !== undefined) storageNotice = message;
    const okay = repository.valid && repository.writable;
    $('storage-state').textContent = okay ? 'хранение доступно' : 'хранение требует внимания';
    $('storage-state').classList.toggle('is-error', !okay);
    $('storage-message').textContent = repository.error || (!repository.writable
      ? 'Не удалось сохранить данные в браузере: хранилище недоступно или заполнено. Работа с задачами будет заблокирована, пока сохранение недоступно.' : storageNotice);
    const state = repository.valid ? repository.state : blankState();
    $('hide-completed').checked = state.preferences.hideCompleted;
    for(const control of document.querySelectorAll('[data-mutation]')) control.disabled=!okay;
    $('error-reset').hidden=okay;
    renderLists();
    updateDemoButton();
    renderReports();
    if(editor)updateEditorFields();
  }

  function selectTab(name, focus = false) {
    for (const tab of ['buffer', 'library']) {
      const active = tab === name;
      $(`${tab}-tab`).setAttribute('aria-selected', String(active));
      $(`${tab}-tab`).tabIndex = active ? 0 : -1;
      $(`${tab}-panel`).hidden = !active;
    }
    if (focus) $(`${name}-tab`).focus();
  }
  $('previous-week').addEventListener('click', () => { revealTaskId=null;selectedMonday = addDays(selectedMonday, -7); renderWeek(); });
  $('next-week').addEventListener('click', () => { revealTaskId=null;selectedMonday = addDays(selectedMonday, 7); renderWeek(); });
  $('current-week').addEventListener('click', () => { revealTaskId=null;todayKey = dateKey(new Date()); selectedMonday = mondayOf(clampedToday()); renderWeek(); });
  for (const name of ['buffer', 'library']) {
    $(`${name}-tab`).addEventListener('click', () => selectTab(name));
    $(`${name}-tab`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        selectTab(event.key === 'Home' ? 'buffer' : event.key === 'End' ? 'library' : name === 'buffer' ? 'library' : 'buffer', true);
      }
    });
  }
  const help = $('help-dialog');
  $('open-help').addEventListener('click', () => { help.showModal(); $('close-help').focus(); });
  $('close-help').addEventListener('click', () => help.close());
  help.addEventListener('close', () => $('open-help').focus());

  function refreshExternal() {
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); } catch { repository.read(); refreshIndexes(); renderStorage(); renderTasks(); return; }
    if (raw !== repository.raw || !repository.valid || !repository.writable) {
      const changed = raw !== repository.raw;
      repository.probe();
      repository.read();
      refreshIndexes();
      if(changed && editor) {
        if(raw === null) { if(confirm.open)closeConfirm(); closeEditor(); }
        else { editor.stale=true; if(confirm.open)closeConfirm(); $('form-error').textContent='Данные изменились в другой вкладке. Закройте карточку и откройте заново.'; }
      }
      renderTasks();
      renderStorage(changed ? 'Планировщик изменён в другой вкладке. Продолжайте редактирование в одной вкладке.' : '');
    }
  }
  window.addEventListener('storage', event => { if (event.key === STORAGE_KEY || event.key === null) refreshExternal(); });
  window.addEventListener('focus', () => { updateClock(); refreshExternal(); renderStorage(); renderTasks(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateClock(); refreshExternal(); renderStorage(); renderTasks(); } });
  const synchronizeScrollbar = () => {
    const scroll = $('workday-scroll');
    const calendar=document.querySelector('.calendar');
    const weekendWidth=Math.max(...['saturday-scroll','sunday-scroll'].map(id=>$(id).offsetWidth-$(id).clientWidth));
    calendar.style.setProperty('--workday-scrollbar', `${scroll.offsetWidth - scroll.clientWidth}px`);
    calendar.style.setProperty('--weekend-scrollbar', `${weekendWidth}px`);
  };
  const scrollbarObserver=new ResizeObserver(synchronizeScrollbar);
  for(const id of ['workday-scroll','saturday-scroll','sunday-scroll'])scrollbarObserver.observe($(id));
  setInterval(() => { updateClock(); renderStorage(); renderTasks(); }, 60000);
  const clockText = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const intervalText = task => `${clockText(task.startMinutes)}–${clockText(task.endMinutes)}`;
  const russianOrder = (a, b) => a.title.localeCompare(b.title, 'ru') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  let editor = null;
  let confirmAction = null;
  let confirmReturnFocus = null;
  let taskReturnFocus = null;
  let tasksByDay = new Map();
  let taskById = new Map();
  let libraryById = new Map();
  const dialog = $('task-dialog');
  const form = $('task-form');
  const confirm = $('confirm-dialog');
  const reset = $('reset-dialog');
  const formIds = ['task-title', 'task-description', 'task-placement', 'task-date', 'task-start', 'task-end', 'task-duration', 'manual-deadline', 'task-deadline', 'deadline-choice', 'add-to-library'];
  const snapshot = () => JSON.stringify(formIds.map(id => $(id).type === 'checkbox' ? $(id).checked : $(id).value));
  const canWrite = () => repository.valid && repository.writable;
  const announce = text => { $('announcement').textContent = text; };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function uniqueId() {
    let id;
    do { id = window.crypto?.randomUUID ? window.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
    while (repository.state.tasks.some(item => item.id === id) || repository.state.library.some(item => item.id === id));
    return id;
  }
  function refreshIndexes() {
    tasksByDay = new Map();
    taskById = new Map();
    libraryById = new Map();
    if (!repository.valid) return;
    for (const item of repository.state.library) libraryById.set(item.id, item);
    for (const task of repository.state.tasks) {
      taskById.set(task.id, task);
      if (task.plannedDate) {
        if (!tasksByDay.has(task.plannedDate)) tasksByDay.set(task.plannedDate, []);
        tasksByDay.get(task.plannedDate).push(task);
      }
    }
  }
  function actionButton(label, action, id) {
    const button = element('button', '', label);
    button.type = 'button'; button.dataset.action = action; button.dataset.id = id;
    button.dataset.mutation = '';
    button.disabled = !canWrite();
    return button;
  }
  function renderLists() {
    const state = repository.valid ? repository.state : blankState();
    const bufferQuery = $('buffer-search').value.trim().toLocaleLowerCase('ru');
    const libraryQuery = $('library-search').value.trim().toLocaleLowerCase('ru');
    const matches = (item, query) => item.title.toLocaleLowerCase('ru').includes(query);
    const overdue = state.tasks.filter(task => isOverdue(task, todayKey));
    const unplanned = state.tasks.filter(task => !task.plannedDate && !isOverdue(task, todayKey));
    $('buffer-count').textContent = String(overdue.length + unplanned.length);
    $('unplanned-count').textContent = String(unplanned.length);
    $('overdue-count').textContent = String(overdue.length);
    $('library-count').textContent = String(state.library.length);
    const groups = [
      ['unplanned', unplanned.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).filter(t => matches(t, bufferQuery)), false],
      ['overdue', overdue.sort((a,b) => a.deadlineDate.localeCompare(b.deadlineDate) || a.title.localeCompare(b.title,'ru') || a.id.localeCompare(b.id)).filter(t => matches(t, bufferQuery)), false],
      ['library', [...state.library].sort(russianOrder).filter(t => matches(t, libraryQuery)), true]
    ];
    for (const [name, items, library] of groups) {
      const list = $(`${name}-list`);
      const signature = JSON.stringify([items, canWrite()]);
      if (list.dataset.signature === signature) continue;
      list.dataset.signature = signature;
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        const card = element('article', `side-card${name === 'overdue' ? ' is-overdue' : ''}`);
        card.dataset.id = item.id;card.draggable = canWrite();
        const title = actionButton(item.title, library ? 'edit-library' : 'edit-task', item.id);
        title.className = 'side-card-title';
        // Просмотр разрешён даже при запрете записи.
        title.disabled = false; delete title.dataset.mutation;
        card.append(title, element('p', '', `${item.durationMinutes} мин${!library && item.deadlineDate ? ` · срок ${fullDate.format(localDate(item.deadlineDate))}` : ''}`));
        if (!library && item.plannedDate) card.append(element('p', '', `в плане ${fullDate.format(localDate(item.plannedDate))}, ${intervalText(item)}`));
        const actions = element('div', 'side-card-actions');
        actions.append(actionButton(library ? 'в буфер' : 'запланировать', library ? 'library-to-buffer' : 'plan-task', item.id));
        card.append(actions); fragment.append(card);
      }
      list.replaceChildren(fragment);
      $(`${name}-copy`).hidden = items.length > 0;
      $(`${name}-copy`).textContent = (name === 'library' ? libraryQuery : bufferQuery) ? 'По этому названию ничего не найдено.'
        : name === 'library' ? 'Добавьте задачи для повторного использования.' : name === 'overdue' ? 'Просроченных задач нет.' : 'Добавьте задачу и выберите для неё день и время.';
    }
  }
  function renderTasks() {
    const state = repository.valid ? repository.state : blankState();
    for (const view of dayViews) {
      const tasks = tasksByDay.get(view.grid.dataset.date) || [];
      const signature = JSON.stringify([tasks, state.preferences.hideCompleted, canWrite(), todayKey, revealTaskId]);
      if (view.layer.dataset.signature !== signature) {
        view.layer.dataset.signature = signature;
        const fragment = document.createDocumentFragment();
        for (const task of tasks) {
          const compact = task.durationMinutes === 30;
          const card = element('article', `task-card${compact ? ' compact' : ''}${task.completed ? ' is-completed' : ''}${isOverdue(task,todayKey) ? ' is-overdue' : ''}`);
          card.dataset.id = task.id;card.classList.toggle('one-hour',task.durationMinutes===60);
          card.style.top = `${task.startMinutes - 360}px`;
          card.style.height = `${task.durationMinutes}px`;
          if (task.completed && state.preferences.hideCompleted && task.id !== revealTaskId) {
            card.classList.add('task-placeholder');
            card.textContent = 'выполненная задача';
            card.title = `выполненная задача, ${intervalText(task)}`;
          } else {
            const check = element('input'); check.type = 'checkbox'; check.checked = task.completed;
            check.dataset.action = 'complete'; check.dataset.id = task.id; check.dataset.mutation = '';
            check.disabled = !canWrite(); check.setAttribute('aria-label', `Выполнена: ${task.title}`);
            const open = element('button', 'task-open'); open.type = 'button'; open.dataset.action = 'edit-task'; open.dataset.id = task.id;
            open.title = `${task.title}, ${intervalText(task)}${isOverdue(task,todayKey) ? ', просрочена' : ''}`;
            open.setAttribute('aria-label', open.title);
            open.append(element('span', 'task-card-title', `${isOverdue(task,todayKey) ? '! ' : ''}${task.title}`), element('span', 'task-time', intervalText(task)));
            if (isOverdue(task,todayKey) && task.durationMinutes>=90) open.append(element('span', 'task-time', 'просрочена'));
            card.append(check, open);
          }
          fragment.append(card);
        }
        view.layer.replaceChildren(fragment);
      }
      for (const slot of view.grid.querySelectorAll('.time-slot')) {
        const minute = Number(slot.dataset.minutes);
        const occupied = tasks.some(t => t.startMinutes <= minute && t.endMinutes > minute);
        slot.disabled = !canWrite() || !validDate(view.grid.dataset.date) || occupied;
        slot.setAttribute('aria-label', `${view.grid.dataset.date}, ${clockText(minute)}${occupied ? ', время занято' : ', создать задачу'}`);
      }
    }
  }
  function renderAll() { refreshIndexes(); renderStorage(); renderTasks(); }
  function commit(candidate) {
    const result = repository.write(candidate);
    if (!result.ok) {
      if (result.reason === 'conflict') {
        if (editor) editor.stale = true;
        if (confirm.open) closeConfirm();
        storageNotice = 'Данные изменились в другой вкладке. Закройте карточку и откройте её заново.';
      } else {
        repository.probe();
        storageNotice = 'Не удалось сохранить изменение. Прежние данные сохранены. Проверьте доступность хранилища.';
      }
      $('form-error').textContent = storageNotice;
      renderAll();
      return false;
    }
    storageNotice = ''; renderAll(); announce('Изменения сохранены.'); return true;
  }
  const candidateState = () => ({ ...repository.state, library: [...repository.state.library], tasks: [...repository.state.tasks] });
  function addLibraryInstance(id) {
    if (!canWrite()) return;
    const item = libraryById.get(id); if (!item) return;
    const stamp = new Date().toISOString();
    const state = candidateState();
    state.tasks.push({ ...item, id: uniqueId(), libraryId: item.id, plannedDate: null, startMinutes: null, endMinutes: null,
      deadlineMode: 'auto', deadlineDate: null, completed: false, completedAt: null, createdAt: stamp, updatedAt: stamp });
    if (commit(state)) selectTab('buffer');
  }
  function populateSelect(id, start, end, text) {
    const fragment = document.createDocumentFragment();
    for (let n=start; n<=end; n+=30) { const option=element('option','',text(n)); option.value=String(n); fragment.append(option); }
    if(id==='task-end'){const placeholder=element('option','','выберите время');placeholder.value='';fragment.prepend(placeholder);}
    $(id).replaceChildren(fragment);
  }
  populateSelect('task-start',360,1350,clockText);
  populateSelect('task-end',390,1380,clockText);
  populateSelect('task-duration',30,1020,n=>`${n} мин`);
  function updateCounters() {
    $('title-count').textContent = `${$('task-title').value.length} / 120`;
    $('description-count').textContent = `${$('task-description').value.length} / 4000`;
  }
  function updateEditorFields() {
    if (!editor) return;
    const library = editor.kind === 'library';
    const schedule = !library && $('task-placement').value === 'schedule';
    const choice = editor.planning && editor.original?.deadlineMode === 'manual';
    $('placement-group').hidden = library;
    $('schedule-fields').hidden = !schedule;
    $('duration-group').hidden = schedule;
    $('deadline-group').hidden = library;
    $('deadline-choice-group').hidden = !choice;
    $('manual-deadline').disabled = choice || !canWrite() || editor.stale;
    $('deadline-date-group').hidden = !$('manual-deadline').checked;
    $('task-deadline').disabled = !canWrite() || editor.stale || (choice && $('deadline-choice').value !== 'change');
    $('task-placement').disabled = Boolean(editor.planning || (editor.original?.plannedDate && !library)) || !canWrite() || editor.stale;
    const locked = Boolean(editor.original?.plannedDate && !editor.planning);
    $('task-date').disabled = locked || !canWrite() || editor.stale;
    $('task-start').disabled = locked || !canWrite() || editor.stale;
    $('placement-info').hidden = !locked;
    $('add-to-library-label').hidden = library || Boolean(editor.original) || Boolean(editor.librarySource);
    $('edit-actions').hidden = !editor.original;
    $('duplicate-task').hidden = library;
    $('return-task').hidden = library || !editor.original?.plannedDate;
    $('return-task').disabled = !canWrite() || editor.stale || Boolean(editor.original?.completed);
    if (editor.original?.completed) $('return-task').title = 'Сначала снимите галочку в плане.';
    else $('return-task').removeAttribute('title');
    for (const id of ['save-task','duplicate-task','delete-task','task-title','task-description','task-end','task-duration','add-to-library','deadline-choice']) $(id).disabled = !canWrite() || editor.stale;
    $('completed-info').hidden = !editor.original?.completed;
    $('completed-info').textContent = editor.original?.completedAt ? `Выполнена ${new Date(editor.original.completedAt).toLocaleString('ru-RU')}` : '';
    updateCounters();
  }
  function openEditor({kind='task', id=null, date=null, start=360, planning=false}={}) {
    const original = id ? (kind === 'library' ? libraryById : taskById).get(id) : null;
    if (id && !original) return;
    taskReturnFocus = document.activeElement;
    form.reset(); for(const node of form.querySelectorAll('[aria-invalid]')){node.removeAttribute('aria-invalid');node.removeAttribute('aria-errormessage');} $('form-error').textContent=''; $('title-error').textContent=''; $('task-title').removeAttribute('aria-invalid');
    editor = { kind, id, original, planning, stale:false };
    $('task-dialog-title').textContent = kind === 'library' ? (id ? 'Запись библиотеки' : 'Добавить в библиотеку') : planning ? 'Запланировать задачу' : id ? 'Задача' : 'Добавить задачу';
    $('task-title').value = original?.title || '';
    $('task-description').value = original?.description || '';
    $('task-duration').value = String(original?.durationMinutes || 30);
    $('task-placement').value = date || planning || original?.plannedDate ? 'schedule' : 'buffer';
    $('task-date').value = date || (planning ? dateKey(clampedToday()) : original?.plannedDate) || dateKey(clampedToday());
    const minute = planning ? 360 : original?.startMinutes ?? start;
    $('task-start').value = String(minute);
    $('task-end').value = String(minute + (original?.durationMinutes || 30));
    $('manual-deadline').checked = original?.deadlineMode === 'manual';
    $('task-deadline').value = original?.deadlineDate || '';
    updateEditorFields(); editor.initial = snapshot();
    dialog.showModal(); $('task-title').focus();
  }
  function closeEditor() {
    dialog.close(); editor=null;
    if (taskReturnFocus?.isConnected && !taskReturnFocus.disabled) taskReturnFocus.focus();
    else $('add-task').focus();
  }
  function ask(copy, action, label='подтвердить', cancelLabel='отмена') {
    confirmReturnFocus = document.activeElement;
    $('confirm-title').textContent = label === 'удалить' ? 'Удаление записи' : 'Подтверждение';
    $('confirm-copy').textContent=copy; $('confirm-error').textContent=''; $('confirm-accept').textContent=label;
    $('confirm-cancel').textContent=cancelLabel;
    confirmAction=action; confirm.showModal(); $('confirm-cancel').focus();
  }
  function closeConfirm() { confirm.close(); confirmAction=null; if(confirmReturnFocus?.isConnected) confirmReturnFocus.focus(); }
  function requestClose() {
    if (editor && !editor.stale && snapshot() !== editor.initial) ask('Закрыть без сохранения? Изменения в карточке будут потеряны.',()=>{closeConfirm();closeEditor();},'закрыть','продолжить редактирование');
    else closeEditor();
  }
  function formError(text, id) {
    $('form-error').textContent=text;
    if (id) { $(id).setAttribute('aria-invalid','true'); $(id).setAttribute('aria-errormessage','form-error'); $(id).focus(); }
  }
  function saveEditor(event) {
    event.preventDefault();
    if (!editor || editor.stale || !canWrite()) return;
    for (const node of form.querySelectorAll('[aria-invalid]')) {node.removeAttribute('aria-invalid');node.removeAttribute('aria-errormessage');}
    $('form-error').textContent=''; $('title-error').textContent='';
    const title=$('task-title').value.trim(), description=$('task-description').value;
    if (!title || title.length>120) { $('title-error').textContent='Введите название от 1 до 120 символов.'; formError($('title-error').textContent,'task-title');return; }
    if(description.length>4000){formError('Описание не должно превышать 4000 символов.','task-description');return;}
    const stamp = new Date().toISOString();
    const duration=Number($('task-duration').value);
    if(editor.kind==='library') {
      if(!validDuration(duration)){formError('Выберите длительность с шагом 30 минут.','task-duration');return;}
      const record={id:editor.id || uniqueId(),title,description,durationMinutes:duration,createdAt:editor.original?.createdAt || stamp,updatedAt:stamp};
      const state=candidateState();state.library=editor.id ? state.library.map(t=>t.id===editor.id?record:t) : [...state.library,record];
      if(commit(state)) closeEditor(); return;
    }
    const schedule=$('task-placement').value==='schedule';
    const date=schedule?$('task-date').value:null;
    const start=schedule?Number($('task-start').value):null, end=schedule?Number($('task-end').value):null;
    if(schedule && !validDate(date)){formError('Выберите дату в диапазоне 2000–2099.','task-date');return;}
    if(schedule && (!Number.isInteger(start)||start<360||start>1350||start%30)){formError('Начало должно быть с 06:00 до 22:30, шаг 30 минут.','task-start');return;}
    if(schedule && (!Number.isInteger(end)||end<=start||end>1380||end%30)){formError('Окончание должно быть позже начала и не позже 23:00, шаг 30 минут.','task-end');return;}
    if(!schedule && !validDuration(duration)){formError('Выберите длительность с шагом 30 минут.','task-duration');return;}
    if(schedule) {
      const conflict=(tasksByDay.get(date)||[]).find(t=>t.id!==editor.id && start<t.endMinutes && end>t.startMinutes);
      if(conflict){formError(`Это время занято задачей «${conflict.title}». Выберите другой интервал.`,'task-end');return;}
    }
    const manual=$('manual-deadline').checked;
    const choiceRequired=editor.planning && editor.original?.deadlineMode==='manual';
    if(choiceRequired && !$('deadline-choice').value){formError('Выберите, сохранить срок или задать новый.','deadline-choice');return;}
    const deadline=manual ? (choiceRequired && $('deadline-choice').value==='keep' ? editor.original.deadlineDate : $('task-deadline').value) : schedule ? date : editor.original?.deadlineMode==='auto' ? editor.original.deadlineDate : null;
    if(manual && !validDate(deadline)){formError('Укажите дату отдельного срока.','task-deadline');return;}
    const record={id:editor.id||uniqueId(),libraryId:editor.original?.libraryId||null,title,description,durationMinutes:schedule?end-start:duration,
      plannedDate:date,startMinutes:start,endMinutes:end,deadlineMode:manual?'manual':'auto',deadlineDate:deadline,
      completed:editor.original?.completed||false,completedAt:editor.original?.completedAt||null,createdAt:editor.original?.createdAt||stamp,updatedAt:stamp};
    const state=candidateState();
    if(!editor.original && $('add-to-library').checked) {
      const library={id:uniqueId(),title,description,durationMinutes:record.durationMinutes,createdAt:stamp,updatedAt:stamp};
      record.libraryId=library.id;state.library.push(library);
    }
    state.tasks=editor.id?state.tasks.map(t=>t.id===editor.id?record:t):[...state.tasks,record];
    const finish=()=>{if(commit(state)){if(confirm.open)closeConfirm();closeEditor();if(!record.plannedDate)selectTab('buffer');}};
    if(manual && schedule && deadline<date) ask('Срок раньше даты планирования. Задача может остаться просроченной. Сохранить?',finish,'сохранить');
    else finish();
  }
  function storedAction(action) {
    if(!editor || editor.stale || !canWrite() || !editor.original) return;
    const item=editor.original; const kind=editor.kind;
    const execute=()=>{
      const state=candidateState();const stamp=new Date().toISOString();
      if(action==='duplicate') state.tasks.push({...item,id:uniqueId(),plannedDate:null,startMinutes:null,endMinutes:null,deadlineMode:'auto',deadlineDate:null,completed:false,completedAt:null,createdAt:stamp,updatedAt:stamp});
      if(action==='return') {
        if(item.completed)return;
        state.tasks=state.tasks.map(t=>t.id===item.id?{...t,plannedDate:null,startMinutes:null,endMinutes:null,updatedAt:stamp}:t);
      }
      if(action==='delete') {
        if(kind==='library'){state.library=state.library.filter(t=>t.id!==item.id);state.tasks=state.tasks.map(t=>t.libraryId===item.id?{...t,libraryId:null,updatedAt:stamp}:t);}
        else state.tasks=state.tasks.filter(t=>t.id!==item.id);
      }
      if(commit(state)){if(confirm.open)closeConfirm();closeEditor();if(action!=='delete')selectTab('buffer');}
      else if(confirm.open)$('confirm-error').textContent=storageNotice;
    };
    if(action==='delete') ask(`Удалить «${item.title}»?${kind==='library'?' Уже созданные задачи останутся.':''}${snapshot()!==editor.initial?' Изменения карточки не будут сохранены.':''}`,execute,'удалить');
    else if(snapshot()!==editor.initial)ask('Продолжить без сохранения изменений карточки? Действие использует сохранённую задачу.',execute,'продолжить');
    else execute();
  }
  form.addEventListener('keydown',event=>{
    if(event.key==='Enter' && event.target.tagName!=='TEXTAREA' && event.target.tagName!=='BUTTON' && !event.isComposing)event.preventDefault();
  });
  form.addEventListener('submit',saveEditor);
  form.addEventListener('input',()=>{updateCounters();});
  form.addEventListener('change',()=>{updateEditorFields();});
  $('task-start').addEventListener('change',()=>{
    const end=Number($('task-start').value)+Number($('task-duration').value);
    $('task-end').value=end<=1380?String(end):'';
    $('form-error').textContent=end>1380?'Задача не помещается до 23:00. Выберите другое начало или явно измените окончание.':'';
  });
  for(const id of ['task-title','task-description']) {
    $(id).addEventListener('beforeinput',event=>{
      if(event.inputType.startsWith('insert') && event.data && $(id).value.length-($(id).selectionEnd-$(id).selectionStart)+event.data.length>$(id).maxLength)announce('Достигнут лимит поля.');
    });
    $(id).addEventListener('paste',event=>{
      const text=event.clipboardData?.getData('text/plain');if(text===undefined)return;
      const input=$(id),space=input.maxLength-(input.value.length-(input.selectionEnd-input.selectionStart));
      if(text.length>space){event.preventDefault();input.setRangeText(text.slice(0,Math.max(0,space)),input.selectionStart,input.selectionEnd,'end');announce('Достигнут лимит поля.');updateCounters();}
    });
  }
  $('close-task').addEventListener('click',requestClose);$('cancel-task').addEventListener('click',requestClose);
  dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
  $('confirm-cancel').addEventListener('click',closeConfirm);
  $('confirm-accept').addEventListener('click',()=>confirmAction?.());
  confirm.addEventListener('cancel',event=>{event.preventDefault();closeConfirm();});
  $('duplicate-task').addEventListener('click',()=>storedAction('duplicate'));
  $('return-task').addEventListener('click',()=>storedAction('return'));
  $('delete-task').addEventListener('click',()=>storedAction('delete'));
  $('add-task').addEventListener('click',()=>openEditor());
  $('add-library').addEventListener('click',()=>openEditor({kind:'library'}));
  $('buffer-search').addEventListener('input',renderLists);$('library-search').addEventListener('input',renderLists);
  document.querySelector('.workspace').addEventListener('click',event=>{
    const node=event.target.closest('[data-action]');if(!node || node.disabled)return;
    const {action,id}=node.dataset;
    if(action==='edit-task')openEditor({id});
    if(action==='edit-library')openEditor({kind:'library',id});
    if(action==='library-to-buffer')addLibraryInstance(id);
    if(action==='plan-task')openEditor({id,planning:true});
    if(action==='create-slot')openEditor({date:node.closest('.day-grid').dataset.date,start:Number(node.dataset.minutes)});
  });
  document.querySelector('.workspace').addEventListener('change',event=>{
    const node=event.target;if(node.dataset.action!=='complete')return;
    const item=taskById.get(node.dataset.id);if(!item)return;
    const state=candidateState();state.tasks=state.tasks.map(t=>t.id===item.id?{...t,completed:node.checked,completedAt:node.checked?new Date().toISOString():null,updatedAt:new Date().toISOString()}:t);
    if(!commit(state)){node.checked=item.completed;renderTasks();}
    const view=dayViews.find(v=>v.grid.dataset.date===item.plannedDate);
    const card=[...(view?.layer.children||[])].find(child=>child.dataset.id===item.id);
    (card?.querySelector('input')||$('hide-completed')).focus({preventScroll:true});
  });
  $('hide-completed').addEventListener('change',()=>{revealTaskId=null;const state=candidateState();state.preferences={hideCompleted:$('hide-completed').checked};commit(state);});
  function openReset() {
    if(confirm.open)closeConfirm();
    $('reset-word').value='';$('reset-error').textContent='';$('reset-accept').disabled=true;reset.showModal();$('reset-cancel').focus();
  }
  $('help-reset').addEventListener('click',openReset);$('error-reset').addEventListener('click',openReset);
  $('reset-word').addEventListener('input',()=>{$('reset-accept').disabled=$('reset-word').value!=='удалить';});
  $('reset-cancel').addEventListener('click',()=>reset.close());
  $('reset-accept').addEventListener('click',()=>{
    if($('reset-word').value!=='удалить')return;
    try{storage.removeItem(STORAGE_KEY);if(storage.getItem(STORAGE_KEY)!==null)throw new Error('reset-failed');}
    catch{$('reset-error').textContent='Не удалось удалить данные. Сброс не выполнен.';return;}
    if(dialog.open)closeEditor();if(help.open)help.close();if(reports.open)closeReports();reset.close();clearDrag();revealTaskId=null;clearHighlight();$('action-message').hidden=true;
    repository.probe();repository.read();storageNotice='';todayKey=dateKey(new Date());selectedMonday=mondayOf(clampedToday());
    $('buffer-search').value='';$('library-search').value='';selectTab('buffer');renderWeek();renderAll();announce('Данные планировщика удалены.');
  });
  const reports = $('reports-dialog');
  let activeReport = 'week';
  let reportSignature = '';
  let reportReturnFocus = null;
  let revealTaskId = null;
  let dragSession = null;
  let highlightedNode = null;
  let highlightTimer = null;
  const DRAG_TYPE = 'application/x-personal-week-planner';
  const DEMO_DATA = [
    { type:'library', ref:'day', title:'Планирование дня', description:'Определить главные задачи.', durationMinutes:30 },
    { type:'library', ref:'project', title:'Работа над проектом', description:'Завершить выбранную часть работы.', durationMinutes:60 },
    { type:'library', ref:'review', title:'Проверка результатов', description:'Проверить выполненное.', durationMinutes:30 },
    { type:'task', libraryRef:'day', dayOffset:0, startMinutes:540, completed:false },
    { type:'task', libraryRef:'project', dayOffset:0, startMinutes:600, completed:true },
    { type:'task', libraryRef:'review', dayOffset:null, completed:false },
    { type:'task', title:'Разобрать заметки', description:'Пример просроченной разовой задачи.', durationMinutes:30, dayOffset:null, deadlineOffset:-1, completed:false }
  ];
  function showAction(message, error=false) {
    $('action-message').textContent=message;
    $('action-message').classList.toggle('is-error',error);
    $('action-message').hidden=false;
  }
  function clearHighlight() {
    if(highlightTimer)clearTimeout(highlightTimer);
    highlightedNode?.classList.remove('is-target'); highlightedNode=null;
  }
  function highlight(node) {
    clearHighlight();if(!node)return;
    highlightedNode=node;node.classList.add('is-target');highlightTimer=setTimeout(clearHighlight,2000);
  }
  function closeReports() { reports.close(); if(reportReturnFocus?.isConnected)reportReturnFocus.focus(); }
  $('open-reports').addEventListener('click',()=>{reportReturnFocus=document.activeElement;reports.showModal();renderReports();$(`report-${activeReport}-tab`).focus();});
  $('close-reports').addEventListener('click',closeReports);
  reports.addEventListener('cancel',event=>{event.preventDefault();closeReports();});
  function selectReport(name, focus=false) {
    activeReport=name;
    for(const tab of $('report-tabs').querySelectorAll('[data-report]')){
      const selected=tab.dataset.report===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    }
    $('report-panel').setAttribute('aria-labelledby',`report-${name}-tab`);renderReports();
    if(focus)$(`report-${name}-tab`).focus();
  }
  $('report-tabs').addEventListener('click',event=>{const tab=event.target.closest('[data-report]');if(tab)selectReport(tab.dataset.report);});
  $('report-tabs').addEventListener('keydown',event=>{
    const names=['week','all','summary'];const tab=event.target.closest('[data-report]');if(!tab)return;
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();let index=names.indexOf(tab.dataset.report);
      index=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;selectReport(names[index],true);
    }
  });
  const calendarDaysBetween = (first, second) => {
    const a=localDate(first),b=localDate(second);
    return Math.round((Date.UTC(b.getFullYear(),b.getMonth(),b.getDate())-Date.UTC(a.getFullYear(),a.getMonth(),a.getDate()))/86400000);
  };
  function reportData() {
    const tasks=repository.valid?repository.state.tasks:[];
    const start=dateKey(selectedMonday),end=dateKey(addDays(selectedMonday,6));
    const scheduled=tasks.filter(t=>t.plannedDate && t.plannedDate>=start && t.plannedDate<=end);
    const completed=scheduled.filter(t=>t.completed).length;
    const overdue=tasks.filter(t=>isOverdue(t,todayKey));
    const rows=activeReport==='summary'?scheduled.filter(t=>!t.completed).sort((a,b)=>a.plannedDate.localeCompare(b.plannedDate)||a.startMinutes-b.startMinutes||a.id.localeCompare(b.id))
      :overdue.filter(t=>activeReport==='all'||(t.deadlineDate>=start&&t.deadlineDate<=end)).sort((a,b)=>a.deadlineDate.localeCompare(b.deadlineDate)||a.title.localeCompare(b.title,'ru')||a.id.localeCompare(b.id));
    return {rows,metrics:[['запланировано',scheduled.length],['выполнено',completed],['не выполнено',scheduled.length-completed],['из них просрочено',scheduled.filter(t=>isOverdue(t,todayKey)).length],['выполнение',`${scheduled.length?Math.round(completed/scheduled.length*100):0}%`]]};
  }
  function renderReports() {
    if(!reports.open)return;
    const {rows,metrics}=reportData();
    const signature=JSON.stringify([activeReport,dateKey(selectedMonday),todayKey,rows,metrics]);
    if(signature===reportSignature)return;
    reportSignature=signature;
    const focused=document.activeElement;
    const restoreAction=focused?.dataset.reportAction;
    const restoreId=focused?.dataset.id;
    $('report-week').textContent=activeReport==='all'?'все недели':`неделя ${fullDate.format(selectedMonday)} – ${fullDate.format(addDays(selectedMonday,6))}`;
    const mf=document.createDocumentFragment();
    for(const [label,value] of activeReport==='summary'?metrics:[['просроченных задач',rows.length]]){
      const box=element('div','metric');box.append(element('span','',label),element('strong','',String(value)));mf.append(box);
    }
    $('report-metrics').replaceChildren(mf);
    const head=element('tr');for(const label of ['задача','срок','размещение',activeReport==='summary'?'состояние':'дней просрочки','действия'])head.append(element('th','',label));
    $('report-head').replaceChildren(head);
    const fragment=document.createDocumentFragment();
    for(const task of rows){
      const late=isOverdue(task,todayKey);const row=element('tr',late?'is-overdue':'');row.dataset.id=task.id;
      row.append(element('td','',task.title),element('td','',task.deadlineDate?fullDate.format(localDate(task.deadlineDate)):'без срока'),element('td','',task.plannedDate?`${fullDate.format(localDate(task.plannedDate))}, ${intervalText(task)}`:'в буфере'),element('td','',activeReport==='summary'?(late?'просрочена':'срок не прошёл'):String(calendarDaysBetween(task.deadlineDate,todayKey))));
      const actions=element('td','report-actions');
      for(const [label,action] of [...(task.plannedDate?[['открыть в плане','plan']]:[]),...(late?[['в буфер','buffer']]:[]),['открыть карточку','card']]){
        const button=element('button','',label);button.dataset.reportAction=action;button.dataset.id=task.id;actions.append(button);
      }
      row.append(actions);fragment.append(row);
    }
    $('report-body').replaceChildren(fragment);
    $('report-empty').hidden=rows.length>0;$('report-table').hidden=rows.length===0;
    $('report-empty').textContent=activeReport==='summary'?'Невыполненных задач в выбранной неделе нет.':'Просроченных задач нет.';
    if(restoreAction){
      const button=[...$('report-body').querySelectorAll('[data-report-action]')].find(node=>node.dataset.id===restoreId&&node.dataset.reportAction===restoreAction);
      (button||$('report-panel')).focus({preventScroll:true});
    }
  }
  function openInPlan(id) {
    const task=taskById.get(id);if(!task?.plannedDate)return;
    if(reports.open)closeReports();
    selectedMonday=mondayOf(localDate(task.plannedDate));revealTaskId=id;renderWeek();
    requestAnimationFrame(()=>{
      const view=dayViews.find(v=>v.grid.dataset.date===task.plannedDate);if(!view)return;
      const viewport=$('calendar-viewport');const rect=view.grid.getBoundingClientRect(),container=viewport.getBoundingClientRect();
      if(rect.left<container.left || rect.right>container.right)viewport.scrollLeft+=rect.left-container.left;
      const scroll=view.grid.closest('.workday-scroll,.weekend-scroll');
      const available=scroll.clientHeight;
      scroll.scrollTop=Math.max(0,task.startMinutes-360-(task.durationMinutes<available?Math.min(30,available-task.durationMinutes):0));
      const card=[...view.layer.children].find(node=>node.dataset.id===id);
      card?.querySelector('.task-open')?.focus({preventScroll:true});highlight(card);
    });
  }
  function openInBuffer(id) {
    const task=taskById.get(id);if(!task || !isOverdue(task,todayKey))return;
    if(reports.open)closeReports();selectTab('buffer');$('buffer-search').value='';renderLists();
    const node=[...$('overdue-list').children].find(n=>n.dataset.id===id);
    node?.scrollIntoView({block:'nearest'});node?.querySelector('button')?.focus({preventScroll:true});highlight(node);
  }
  $('report-body').addEventListener('click',event=>{
    const button=event.target.closest('[data-report-action]');if(!button)return;
    const {id,reportAction}=button.dataset;
    if(reportAction==='plan')openInPlan(id);
    if(reportAction==='buffer')openInBuffer(id);
    if(reportAction==='card'){closeReports();openEditor({id});taskReturnFocus=$('open-reports');}
  });
  function updateDemoButton() {
    const empty=repository.valid && repository.state.tasks.length===0 && repository.state.library.length===0;
    $('load-demo').hidden=!empty;
    $('load-demo').disabled=!canWrite() || !validDate(todayKey) || !validDate(dateKey(addDays(localDate(todayKey),-1)));
  }
  $('load-demo').addEventListener('click',()=>{
    if(!canWrite()||repository.state.tasks.length||repository.state.library.length||$('load-demo').disabled)return;
    const state=candidateState(),refs=new Map(),stamp=new Date().toISOString(),reserved=new Set();
    const id=()=>{let value;do{value=uniqueId();}while(reserved.has(value));reserved.add(value);return value;};
    for(const item of DEMO_DATA.filter(t=>t.type==='library')){
      const entry={id:id(),title:item.title,description:item.description,durationMinutes:item.durationMinutes,createdAt:stamp,updatedAt:stamp};refs.set(item.ref,entry);state.library.push(entry);
    }
    for(const item of DEMO_DATA.filter(t=>t.type==='task')){
      const source=refs.get(item.libraryRef),date=item.dayOffset===null?null:dateKey(addDays(localDate(todayKey),item.dayOffset));
      const duration=source?.durationMinutes||item.durationMinutes;
      state.tasks.push({id:id(),libraryId:source?.id||null,title:source?.title||item.title,description:source?.description||item.description,durationMinutes:duration,
        plannedDate:date,startMinutes:date?item.startMinutes:null,endMinutes:date?item.startMinutes+duration:null,
        deadlineMode:item.deadlineOffset===undefined?'auto':'manual',deadlineDate:item.deadlineOffset===undefined?date:dateKey(addDays(localDate(todayKey),item.deadlineOffset)),
        completed:item.completed,completedAt:item.completed?stamp:null,createdAt:stamp,updatedAt:stamp});
    }
    if(commit(state)){selectedMonday=mondayOf(localDate(todayKey));renderWeek();showAction('Примеры загружены. Их можно изменять и удалять как обычные задачи.');}
  });
  function clearPreview() { for(const node of document.querySelectorAll('.drop-preview'))node.remove(); }
  function clearDrag() { clearPreview();document.querySelectorAll('.is-dragging').forEach(node=>node.classList.remove('is-dragging'));dragSession=null; }
  function draggedItem() {
    if(!dragSession || !canWrite() || dragSession.raw!==repository.raw)return null;
    const item=(dragSession.kind==='library'?libraryById:taskById).get(dragSession.id);
    if(!item || item.completed || (dragSession.kind==='task' && item.plannedDate && !isOverdue(item,todayKey)))return null;
    return item;
  }
  function dragTarget(event,grid) {
    const item=draggedItem();if(!item)return null;
    const rect=grid.getBoundingClientRect();
    const start=360+Math.floor((event.clientY-rect.top)/(rect.height/1020)/30)*30;
    const end=start+item.durationMinutes,date=grid.dataset.date;
    const conflict=(tasksByDay.get(date)||[]).find(t=>t.id!==(dragSession.kind==='task'?item.id:null)&&start<t.endMinutes&&end>t.startMinutes);
    const valid=validDate(date)&&start>=360&&start<=1350&&end<=1380&&!conflict;
    return {item,date,start,end,valid,reason:conflict?`Время занято: ${conflict.title}`:'Интервал выходит за границы расписания.'};
  }
  document.querySelector('.workspace').addEventListener('dragstart',event=>{
    const card=event.target.closest('.side-card');if(!card || !canWrite()){event.preventDefault();return;}
    const kind=card.closest('#library-list')?'library':'task',item=(kind==='library'?libraryById:taskById).get(card.dataset.id);
    if(!item||item.completed){event.preventDefault();return;}
    dragSession={kind,id:item.id,token:uniqueId(),raw:repository.raw};
    event.dataTransfer.setData(DRAG_TYPE,JSON.stringify({kind,id:item.id,token:dragSession.token}));
    event.dataTransfer.effectAllowed=kind==='library'?'copy':'move';card.classList.add('is-dragging');
  });
  document.querySelector('.workspace').addEventListener('dragover',event=>{
    const grid=event.target.closest('.day-grid');
    if(!grid||!dragSession||!Array.from(event.dataTransfer.types).includes(DRAG_TYPE)){clearPreview();return;}
    event.preventDefault();const target=dragTarget(event,grid);clearPreview();if(!target)return;
    event.dataTransfer.dropEffect=target.valid?(dragSession.kind==='library'?'copy':'move'):'none';
    const preview=element('div',`drop-preview${target.valid?'':' is-invalid'}`,target.valid?`${clockText(target.start)}–${clockText(target.end)}`:target.reason);
    preview.style.top=`${Math.max(0,target.start-360)}px`;preview.style.height=`${Math.max(0,Math.min(target.item.durationMinutes,1380-target.start))}px`;grid.append(preview);
  });
  document.querySelector('.workspace').addEventListener('dragleave',event=>{if(!event.relatedTarget?.closest?.('.day-grid'))clearPreview();});
  document.addEventListener('dragend',clearDrag);
  // Внешние файлы не должны открываться поверх локального планировщика.
  document.addEventListener('dragover',event=>{
    if(!dragSession || !event.target.closest?.('.day-grid')){
      event.preventDefault();event.dataTransfer.dropEffect='none';clearPreview();
    }
  });
  document.addEventListener('drop',event=>{event.preventDefault();clearDrag();});
  document.querySelector('.workspace').addEventListener('drop',event=>{
    const grid=event.target.closest('.day-grid');if(!grid||!dragSession)return;
    event.preventDefault();
    try{
      const payload=JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      if(payload.kind!==dragSession.kind||payload.id!==dragSession.id||payload.token!==dragSession.token||event.dataTransfer.files.length)return;
      const target=dragTarget(event,grid);if(!target)return;
      if(!target.valid){showAction(target.reason,true);return;}
      const {item,date,start,end}=target,state=candidateState(),stamp=new Date().toISOString();
      const record=dragSession.kind==='library'?{...item,id:uniqueId(),libraryId:item.id,deadlineMode:'auto',deadlineDate:date,completed:false,completedAt:null,createdAt:stamp,updatedAt:stamp}
        :{...item,deadlineDate:item.deadlineMode==='auto'?date:item.deadlineDate,updatedAt:stamp};
      Object.assign(record,{plannedDate:date,startMinutes:start,endMinutes:end});
      state.tasks=dragSession.kind==='library'?[...state.tasks,record]:state.tasks.map(t=>t.id===record.id?record:t);
      if(commit(state))showAction(record.deadlineMode==='manual'?`Задача перенесена, срок сохранён: ${fullDate.format(localDate(record.deadlineDate))}.${isOverdue(record,todayKey)?' Задача остаётся просроченной.':''}`:'Задача размещена в расписании.');
    }catch{showAction('Не удалось распознать перенос. Исходная задача не изменена.',true);}
    finally{clearDrag();}
  });

  refreshIndexes();

  renderWeek();
  renderStorage();
})();
