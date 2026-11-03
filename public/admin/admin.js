const $ = selector => document.querySelector(selector);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
let csrf, state, revision, dirty = false, saving = false, view = 'products', selectedId;
let media = [], chooseImage, uploading = false;
function normalizeState() {
  state.reviews ||= []; state.events ||= [];
  state.products.forEach(p => p.images = [p.image, ...(p.images || []).filter(url => url !== p.image)]);
}
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
if (setupToken) history.replaceState(null, '', location.pathname);
let session, fields;
const notice = (message, error = false) => { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); };
new ResizeObserver(entries => document.documentElement.style.setProperty('--notice-height', `${entries[0].borderBoxSize[0].blockSize}px`)).observe($('#notice'));

async function api(path, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers };
  const response = await fetch('/api/' + path, { ...options, headers, cache: 'no-store' });
  const data = await response.json().catch(() => ({ error: response.status === 413 ? 'Файл слишком большой. Максимум 12 МБ.' : 'Сервер временно недоступен. Попробуйте ещё раз.' }));
  if (!response.ok) {
    if (response.status === 401) notice('Сеанс закончился. Скачайте копию изменений и войдите заново.', true);
    throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.'), data);
  }
  return data;
}

function markDirty() {
  dirty = true;
  $('#save').disabled = saving;
  notice('Есть несохранённые изменения. Нажмите «Сохранить на сайте».');
}

function button(text, action, style = 'secondary') {
  const b = el('button', text, style); b.type = 'button'; b.addEventListener('click', action); return b;
}

function field(label, value, update, type = 'text', max = 5000) {
  const wrapper = el('label', label);
  const multiline = type === 'text' && max > 250;
  const input = document.createElement(multiline ? 'textarea' : 'input');
  if (!multiline) input.type = type === 'text' ? 'text' : type;
  input.value = value;
  input.maxLength = max;
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); update(input.value); markDirty(); });
  wrapper.append(input);
  return wrapper;
}

function imageField(label, value, update) {
  const wrap = el('div', undefined, 'image-field');
  wrap.append(el('span', label));
  const pick = button('', () => openMedia(url => {
    update(url); img.src = url; markDirty();
  }), 'image-button');
  const img = el('img'); img.src = value || '/favicon.svg'; img.alt = label;
  pick.append(img, el('span', 'Выбрать или загрузить фото'));
  wrap.append(pick); return wrap;
}

function check(label, value, update) {
  const wrap = el('label', undefined, 'check');
  const input = el('input'); input.type = 'checkbox'; input.checked = value;
  input.addEventListener('change', () => { update(input.checked); markDirty(); });
  wrap.append(input, document.createTextNode(label)); return wrap;
}

function confirmAction(title, text, action) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').onclick = () => { $('#confirm-dialog').close(); action(); };
  $('#confirm-dialog').showModal();
}

function heading(title, description, action) {
  const row = el('div', undefined, 'page-heading');
  const copy = el('div'); copy.append(el('h1', title), el('p', description)); row.append(copy);
  if (action) row.append(action);
  $('#editor').append(row);
}

function navigate(next) {
  view = next; renderNav(); render();
}

function renderNav() {
  const nav = $('#navigation'); nav.replaceChildren();
  const add = (id, text) => {
    const b = button(text, () => navigate(id), '');
    if (view === id) b.setAttribute('aria-current', 'page');
    nav.append(b);
  };
  add('products', 'Украшения');
  add('media', 'Библиотека фото');
  add('reviews', 'Отзывы и фото покупательниц');
  add('events', 'СОБытия');
  nav.append(el('span', 'Разделы сайта', 'nav-label'));
  [...new Set(fields.map(f => f.group))].forEach(group => add(group, group));
  add('stories', 'Фотографии первого экрана');
  add('faq', 'Ответы на вопросы');
  add('steps', 'Шаги заказа');
  nav.append(el('span', 'Управление', 'nav-label'));
  add('history', 'История изменений'); add('account', 'Пароль и вход');
}

function renderProducts() {
  heading('Украшения', `${state.products.length} карточек. Добавьте работу, выберите фото и заполните описание. Черновик можно сохранить скрытым и закончить позже.`, button('Добавить украшение', () => {
    const product = {id: crypto.randomUUID(), name: 'Новое украшение', image: '/assets/bridal.webp', category: 'Серьги', detail: '', description: '', types: ['earrings'], source: '', visible: false};
    state.products.unshift(product); selectedId = product.id; markDirty(); render();
  }, ''));
  if (!state.products.length) {
    const empty = el('div', undefined, 'empty'); empty.append(el('h2', 'В галерее пока нет украшений'), el('p', 'Добавьте первую работу. Сначала можно сохранить её скрытой.')); $('#editor').append(empty); return;
  }
  const layout = el('div', undefined, 'editor-grid');
  const list = el('div', undefined, 'product-list');
  if (!state.products.some(p => p.id === selectedId)) selectedId = state.products[0].id;
  state.products.forEach((product, i) => {
    const row = button('', () => { selectedId = product.id; render(); }, 'product-row');
    row.setAttribute('aria-current', String(selectedId === product.id));
    const img = el('img'); img.src = product.image; img.alt = ''; img.loading = 'lazy';
    const text = el('span', product.name); text.append(el('small', `${String(i + 1).padStart(2, '0')} · ${product.visible ? 'На сайте' : 'Скрыто'}`));
    row.append(img, text); list.append(row);
  });
  const product = state.products.find(p => p.id === selectedId);
  const editor = el('div', undefined, 'panel'); editor.append(el('h2', 'Карточка украшения'));
  editor.append(field('Название', product.name, v => {
    product.name = v;
    const row = list.querySelector('[aria-current=true] span'); row.firstChild.textContent = v;
  }, 'text', 150));
  editor.append(galleryField(product, true));
  editor.append(field('Название категории на карточке', product.category, v => product.category = v, 'text', 80));
  editor.append(field('Короткая подпись', product.detail, v => product.detail = v, 'text', 250));
  editor.append(field('Описание в открытой карточке', product.description, v => product.description = v));
  ['name','category','detail','description'].forEach((key, i) => editor.querySelectorAll('input,textarea')[i].dataset.field = key);
  editor.append(el('p', 'Описание нужно для публикации. У скрытого черновика оно может быть пустым. Короткая подпись необязательна.', 'hint'));
  editor.append(field('Ссылка на публикацию, необязательно', product.source, v => product.source = v, 'url', 1000));
  const filters = el('fieldset', undefined, 'fieldset'); filters.append(el('legend', 'В каких подборках показывать'));
  [['earrings','Серьги'],['pendants','Подвески'],['wedding','Для невесты']].forEach(([id, title]) => filters.append(check(title, product.types.includes(id), checked => {
    product.types = checked ? [...new Set([...product.types, id])] : product.types.filter(t => t !== id);
  })));
  editor.append(filters, check('Показывать на сайте', product.visible, v => {
    product.visible = v; list.querySelector('[aria-current=true] small').textContent = `${String(state.products.indexOf(product) + 1).padStart(2,'0')} · ${v ? 'На сайте' : 'Скрыто'}`;
  }));
  const actions = el('div', undefined, 'actions');
  for (const [direction, title] of [[-1,'Выше ↑'],[1,'Ниже ↓']]) {
    const b = button(title, () => {
      const i = state.products.indexOf(product); const j = i + direction;
      [state.products[i], state.products[j]] = [state.products[j], state.products[i]]; markDirty(); render();
    });
    b.disabled = direction < 0 ? state.products[0] === product : state.products.at(-1) === product; actions.append(b);
  }
  actions.append(button('Удалить', () => confirmAction('Удалить украшение?', `«${product.name}» исчезнет из галереи после сохранения. Предыдущая версия останется в истории.`, () => {
    state.products = state.products.filter(p => p !== product); selectedId = undefined; markDirty(); render();
  }), 'danger'));
  editor.append(actions); layout.append(list, editor); $('#editor').append(layout);
}

function renderSection() {
  heading(view, 'Здесь можно менять текст и фотографии. Перенос строки в поле сохраняется на сайте.');
  const form = el('div', undefined, 'panel');
  fields.filter(f => f.group === view).forEach(f => {
    const update = value => state.sections[f.id] = value;
    form.append(f.type === 'image' ? imageField(f.label, state.sections[f.id], update) : field(f.label, state.sections[f.id], update, f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text'));
  });
  $('#editor').append(form);
}

function galleryField(item, product = false) {
  const wrap = el('div', undefined, 'gallery-editor');
  wrap.append(el('h3', product ? 'Фотографии украшения' : 'Фотографии'));
  wrap.append(el('p', 'Первое фото — обложка. Можно добавить до 20 снимков, заменить их и менять порядок.', 'hint'));
  const images = product ? (item.images ||= [item.image]) : (item.images ||= []);
  const sync = () => { if (product) item.image = images[0]; markDirty(); render(); };
  const list = el('div', undefined, 'gallery-editor-grid');
  images.forEach((url, i) => {
    const card = el('div', undefined, 'gallery-editor-item');
    const img = el('img'); img.src = url; img.alt = `Фото ${i + 1}`;
    card.append(img, el('span', i ? `Фото ${i + 1}` : 'Обложка'));
    const actions = el('div', undefined, 'actions');
    actions.append(button('Заменить', () => openMedia(value => { images[i] = value; sync(); })));
    if (i) actions.append(button('На обложку', () => { images.unshift(images.splice(i, 1)[0]); sync(); }));
    for (const [direction, text] of [[-1,'←'],[1,'→']]) {
      const move = button(text, () => { [images[i], images[i + direction]] = [images[i + direction], images[i]]; sync(); });
      move.setAttribute('aria-label', `Фото ${i + 1}: ${direction < 0 ? 'раньше' : 'позже'}`);
      move.disabled = i + direction < 0 || i + direction >= images.length; actions.append(move);
    }
    const remove = button('Убрать', () => { images.splice(i, 1); sync(); }, 'danger');
    remove.disabled = product && images.length === 1;
    actions.append(remove); card.append(actions); list.append(card);
  });
  const add = button('Добавить фото', () => openMedia(url => {
    if (!images.includes(url)) images.push(url); sync();
  }));
  add.disabled = images.length >= 20;
  wrap.append(list, add); return wrap;
}

function renderEntries(key) {
  const isEvent = key === 'events';
  heading(isEvent ? 'СОБытия' : 'Отзывы и фото покупательниц', isEvent ? 'Проекты, выставки и ярмарки. Дату можно оставить пустой.' : 'Фото в украшениях и скриншоты отзывов. Добавляйте только согласованные материалы, без личных контактов.', button(isEvent ? 'Добавить событие' : 'Добавить отзыв', () => {
    state[key].unshift({id:crypto.randomUUID(),title:isEvent ? 'Новое событие' : 'Новый отзыв',text:'',images:[],source:'',date:'',visible:false}); markDirty(); render();
  }, ''));
  if (!state[key].length) $('#editor').append(el('p', 'Добавьте первую запись. Она появится на сайте после включения показа и сохранения.', 'empty'));
  const list = el('div', undefined, 'section-list');
  state[key].forEach((item, i) => {
    const panel = el('article', undefined, 'panel'); panel.dataset.entryId = item.id;
    panel.append(el('h2', `${i + 1}. ${item.title}`));
    panel.append(field('Заголовок', item.title, value => item.title = value, 'text', 150));
    if (isEvent) panel.append(field('Дата, необязательно', item.date || '', value => item.date = value, 'date', 10));
    panel.append(field(isEvent ? 'Рассказ о событии' : 'Текст или подпись к отзыву', item.text, value => item.text = value, 'text', 10000));
    panel.append(galleryField(item));
    panel.append(field('Ссылка на публикацию мастера, необязательно', item.source, value => item.source = value, 'url', 1000));
    panel.append(check('Показывать на сайте', item.visible, value => item.visible = value));
    const actions = el('div', undefined, 'actions');
    for (const [direction, text] of [[-1,'Выше ↑'],[1,'Ниже ↓']]) {
      const move = button(text, () => { [state[key][i],state[key][i+direction]]=[state[key][i+direction],state[key][i]]; markDirty(); render(); });
      move.disabled = i + direction < 0 || i + direction >= state[key].length; actions.append(move);
    }
    actions.append(button('Удалить запись', () => confirmAction('Удалить запись?', 'После сохранения её можно будет вернуть через историю изменений.', () => { state[key].splice(i,1); markDirty(); render(); }), 'danger'));
    panel.append(actions); list.append(panel);
  });
  $('#editor').append(list);
}

function renderLibrary() {
  heading('Библиотека фото', 'Загрузите фотографии с телефона. Они сразу сохранятся в библиотеке: позже можно открыть админку на компьютере и выбрать их для карточек, отзывов или событий.', button('Загрузить фотографии', () => openMedia(null)));
  const list = el('div', 'Загружаем фотографии…', 'media-grid'); $('#editor').append(list);
  api('admin/media').then(urls => {
    if (view !== 'media') return;
    list.replaceChildren(...urls.map((url, i) => {
      const card = el('figure'); const img = el('img'); img.src = url; img.alt = `Фото ${i+1}`; img.loading = 'lazy';
      card.append(img, el('figcaption', `Фото ${i+1}`)); return card;
    }));
    if (!urls.length) list.textContent = 'Пока нет фотографий. Загрузите первые снимки.';
  }).catch(error => list.textContent = error.message);
}

function renderRepeater(key, title, description, config) {
  heading(title, description, key === 'faq' ? button('Добавить вопрос', () => { state.faq.push({question:'Новый вопрос',answer:''}); markDirty(); render(); }) : undefined);
  const list = el('div', undefined, 'section-list');
  state[key].forEach((item, i) => {
    const panel = el('div', undefined, 'panel'); panel.append(el('h2', `${i + 1}. ${item.name || item.question || item.title}`));
    config.forEach(([name, label, type]) => panel.append(type === 'image' ? imageField(label, item[name], v => item[name] = v) : field(label, item[name], v => item[name] = v, type || 'text')));
    if (key === 'faq') {
      const actions = el('div', undefined, 'actions');
      if (i) actions.append(button('Выше ↑', () => { [state.faq[i-1],state.faq[i]]=[state.faq[i],state.faq[i-1]]; markDirty(); render(); }));
      const remove = button('Удалить вопрос', () => confirmAction('Удалить вопрос?', 'Изменение вступит в силу после сохранения.', () => { state.faq.splice(i,1); markDirty(); render(); }), 'danger'); remove.disabled = state.faq.length === 1; actions.append(remove); panel.append(actions);
    }
    list.append(panel);
  });
  $('#editor').append(list);
}

async function renderHistory() {
  heading('История изменений', 'Храним 100 последних сохранений. Восстановление загрузит выбранную версию в редактор. Проверьте её и нажмите «Сохранить на сайте».');
  const list = el('div', 'Загружаем историю…', 'section-list'); $('#editor').append(list);
  try {
    const versions = await api('admin/history'); list.replaceChildren();
    versions.forEach(item => {
      const row = el('div', undefined, 'history-row');
      row.append(el('span', `Версия ${item.revision} · ${new Date(item.updated).toLocaleString('ru-RU')}`), button('Восстановить', () => confirmAction('Загрузить эту версию?', 'Несохранённые изменения будут заменены выбранной версией. Сначала можно скачать свою копию.', async () => {
        try { const data = await api(`admin/history/${item.revision}`); state = data.content; normalizeState(); markDirty(); navigate('products'); }
        catch (error) { notice(error.message, true); }
      })));
      list.append(row);
    });
  } catch (error) { list.textContent = error.message; }
}

function renderAccount() {
  heading('Пароль и вход', 'Один пароль для владельца мастерской. При смене пароля остальные сеансы завершаются.');
  const form = el('form', undefined, 'panel');
  const current = field('Текущий пароль', '', () => {}, 'password', 256);
  const next = field('Новый пароль, от 12 символов', '', () => {}, 'password', 256);
  const repeat = field('Повторите новый пароль', '', () => {}, 'password', 256);
  // Account fields are separate from the editable site document.
  form.append(current, next, repeat);
  const inputs = [...form.querySelectorAll('input')];
  inputs.forEach((input, i) => { input.required = true; input.autocomplete = i ? 'new-password' : 'current-password'; if (i) input.minLength = 12; });
  const submit = el('button', 'Изменить пароль'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('input', event => event.stopImmediatePropagation(), true);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (inputs[1].value !== inputs[2].value) { notice('Новые пароли не совпадают.', true); return; }
    submit.disabled = true;
    try { const result = await api('password', {method:'POST',body:JSON.stringify({current:inputs[0].value,password:inputs[1].value})}); csrf = result.csrf; form.reset(); notice('Пароль изменён. Другие сеансы завершены.'); }
    catch (error) { notice(error.message, true); }
    finally { submit.disabled = false; }
  });
  $('#editor').append(form);
}

function render() {
  $('#editor').replaceChildren();
  if (view === 'products') renderProducts();
  else if (view === 'media') renderLibrary();
  else if (view === 'reviews' || view === 'events') renderEntries(view);
  else if (view === 'stories') renderRepeater('stories', 'Фотографии первого экрана', 'Три истории сменяются вместе с маленькой карточкой. Они редактируются отдельно от галереи.', [['name','Название истории'],['image','Большая фотография','image'],['detailImage','Маленькая фотография','image'],['source','Ссылка на публикацию','url']]);
  else if (view === 'faq') renderRepeater('faq', 'Ответы на вопросы', 'Добавляйте и редактируйте вопросы покупателей.', [['question','Вопрос'],['answer','Ответ']]);
  else if (view === 'steps') renderRepeater('steps', 'Как заказать', 'Три шага от знакомства к заказу.', [['title','Название шага'],['text','Описание']]);
  else if (view === 'history') renderHistory();
  else if (view === 'account') renderAccount();
  else renderSection();
}

async function enter() {
  const data = await api('admin/content'); state = data.content; normalizeState(); revision = data.revision;
  $('#auth').hidden = true; $('#workspace').hidden = false;
  setupToken = null;
  renderNav(); render(); notice(`Все изменения сохранены · версия ${revision}`);
}

$('#save').addEventListener('click', async () => {
  saving = true; $('#save').disabled = true; $('#save').textContent = 'Сохраняем…';
  // Work on a snapshot, so edits made during a request are not silently lost.
  const snapshot = JSON.stringify(state);
  try {
    const data = await api('admin/content', {method:'PUT',body:JSON.stringify({revision,content:JSON.parse(snapshot)})});
    revision = data.revision;
    dirty = JSON.stringify(state) !== snapshot;
    notice(dirty ? 'Версия сохранена. Есть новые несохранённые изменения.' : `Сохранено на сайте · версия ${revision}`);
  } catch (error) {
    if (error.section) {
      if (error.section === 'products') selectedId = error.itemId;
      navigate(error.section);
      const input = error.field ? document.querySelector(`[data-field="${error.field}"]`) : null;
      const target = input || [...document.querySelectorAll('[data-entry-id]')].find(node => node.dataset.entryId === error.itemId);
      if (input) input.setAttribute('aria-invalid', 'true');
      target?.scrollIntoView({block:'center'}); input?.focus({preventScroll:true});
    }
    notice(error.message, true);
  }
  finally { saving = false; $('#save').disabled = !dirty; $('#save').textContent = 'Сохранить на сайте'; }
});

async function openMedia(callback) {
  chooseImage = callback; $('#media-title').textContent = callback ? 'Выберите фотографию' : 'Загрузите фотографии';
  $('#upload').multiple = !callback;
  $('#media-dialog').showModal(); $('#media-status').textContent = 'Загружаем фотографии…';
  $('#upload').value = '';
  try { media = await api('admin/media'); renderMedia(); $('#media-status').textContent = `${media.length} фотографий`; }
  catch (error) { $('#media-status').textContent = error.message; }
}

function renderMedia() {
  $('#media-grid').replaceChildren(...media.map((url, i) => {
    const b = button('', () => { if (chooseImage) { chooseImage(url); $('#media-dialog').close(); } }, '');
    const img = el('img'); img.src = url; img.alt = `Фото ${i + 1}`; img.loading = 'lazy';
    b.append(img, el('span', url.startsWith('/assets/') ? url.split('/').at(-1) : 'Загруженная фотография')); return b;
  }));
}

$('#upload').addEventListener('change', async event => {
  const files = [...event.target.files]; if (!files.length || uploading) return;
  uploading = true; $('#upload').disabled = true; $('[data-close="media-dialog"]').disabled = true;
  let count = 0; const errors = [];
  try {
    for (const file of files) {
      $('#media-status').textContent = `Подготавливаем фото ${count + errors.length + 1} из ${files.length}…`;
      try {
        if (file.size > 12 * 1024 * 1024) throw new Error('Файл больше 12 МБ.');
        const form = new FormData(); form.append('file', file);
        const result = await api('admin/upload', {method:'POST',body:form}); media.unshift(result.url); count++;
        if (chooseImage) { chooseImage(result.url); $('#media-dialog').close(); notice('Фото выбрано. Сохраните изменения карточки.'); break; }
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    renderMedia();
    $('#media-status').textContent = `Загружено: ${count}. ${errors.join(' ')}`;
    $('#media-status').classList.toggle('error', errors.length > 0);
    if (view === 'media') renderLibraryView();
  } finally { uploading = false; $('#upload').disabled = false; $('#upload').value = ''; $('[data-close="media-dialog"]').disabled = false; }
});
function renderLibraryView() { if (view === 'media') render(); }
$('#media-dialog').addEventListener('cancel', event => { if (uploading) event.preventDefault(); });

document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).close()));
$('#download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({revision,content:state},null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = `farforiya-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice('Копия текстов и карточек скачана. Фотографии хранятся на сервере отдельно.');
});
$('#logout').addEventListener('click', () => {
  const run = async () => { try { await api('logout',{method:'POST',body:'{}'}); dirty = false; location.reload(); } catch (error) { notice(error.message,true); } };
  if (dirty) confirmAction('Выйти без сохранения?', 'Несохранённые изменения пропадут. Можно сначала скачать копию или сохранить сайт.', run); else run();
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-error').textContent = '';
  const password = $('#auth-password').value;
  if (!session.initialized && password !== $('#auth-repeat').value) { $('#auth-error').textContent = 'Пароли не совпадают.'; return; }
  $('#auth-submit').disabled = true;
  try {
    const data = await api(session.initialized ? 'login' : 'setup', {method:'POST',body:JSON.stringify({password,token:setupToken})});
    csrf = data.csrf; $('#auth-form').reset(); await enter();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { $('#auth-submit').disabled = false; }
});

try {
  [session, fields] = await Promise.all([api('session'), fetch('/admin/fields.json').then(r => r.json())]);
  csrf = session.csrf;
  if (session.authenticated) await enter();
  else {
    $('#auth').hidden = false; notice('Мастерская · Фарфория');
    if (!session.initialized) {
      $('#auth-title').textContent = setupToken ? 'Создайте пароль' : 'Первый вход';
      $('#auth-description').textContent = setupToken ? 'Придумайте пароль от 12 символов и сохраните его. Ссылка настройки работает один раз.' : 'Для первого входа нужна персональная ссылка настройки, которую получил владелец сайта.';
      $('#auth-form').hidden = !setupToken;
      $('#repeat-label').hidden = false; $('#auth-repeat').required = true; $('#auth-repeat').minLength = 12;
      $('#auth-password').minLength = 12; $('#auth-password').autocomplete = 'new-password';
      $('#auth-submit').textContent = 'Создать пароль и войти';
    }
    $('#auth-password').focus();
  }
} catch (error) { notice('Не удалось открыть мастерскую. ' + error.message, true); }
