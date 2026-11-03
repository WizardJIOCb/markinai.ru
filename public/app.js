const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const [pageContent, fields] = await Promise.all([
  fetch('/api/content', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    .then(response => { if (!response.ok) throw new Error('Content unavailable'); return response.json(); })
    .then(data => data.content)
    .catch(() => fetch('/content.json').then(response => response.json())),
  fetch('/admin/fields.json').then(response => response.json()),
]);
const works = pageContent.products.filter(work => work.visible);
// Editors enter plain text. No content from the CMS is interpreted as HTML.
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
fields.forEach(field => $$(field.selector).forEach(element => {
  const value = pageContent.sections[field.id];
  if (field.attribute) {
    element.setAttribute(field.attribute, field.type === 'phone' ? `tel:${value}` : value);
  } else {
    const icons = [...element.querySelectorAll(':scope > svg')];
    if (field.id === 'looksTitle' && value.includes('\n')) {
      const [first, ...rest] = value.split('\n');
      const accent = document.createElement('span'); accent.textContent = rest.join('\n');
      element.replaceChildren(document.createTextNode(first + '\n'), accent);
    } else element.replaceChildren(document.createTextNode(value), ...icons);
    element.style.whiteSpace = 'pre-line';
  }
}));
$('.question-list').replaceChildren(...pageContent.faq.map(item => {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const plus = document.createElement('span'); plus.textContent = '+'; plus.setAttribute('aria-hidden', 'true');
  summary.append(document.createTextNode(item.question), plus);
  const answer = document.createElement('p'); answer.textContent = item.answer;
  details.append(summary, answer); return details;
}));
pageContent.steps.forEach((step, index) => {
  const item = $$('.steps li')[index];
  item.querySelector('h3').textContent = step.title;
  item.querySelector('p').textContent = step.text;
});
pageContent.stories.forEach((story, index) => {
  const image = $(`[data-slide-image="${index}"]`);
  image.src = story.image; image.alt = story.name;
  const detail = $(`[data-detail-image="${index}"]`);
  detail.src = story.detailImage; detail.alt = story.name;
  $(`[data-slide="${index}"]`).setAttribute('aria-label', story.name);
});
$('[data-filter="all"] span').textContent = works.length;
$('#selected-work').replaceChildren(new Option('Пока выбираю', 'Пока выбираю'), ...works.map(work => new Option(work.name, work.id)), new Option('Своя идея', 'Своя идея'));
$('#empty-state').hidden = works.length > 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scrollBehavior = () => reduceMotion.matches ? 'instant' : 'smooth';
const arrow = '<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg>';
const grid = $('#works-grid');

function renderJournal(key) {
  const items = (pageContent[key] || []).filter(item => item.visible);
  const section = $('#' + key); section.hidden = !items.length;
  $$(`a[href="#${key}"]`).forEach(link => link.hidden = !items.length);
  const target = $('#' + key + '-grid');
  items.forEach(item => {
    const card = document.createElement('article'); card.className = 'journal-card'; card.dataset.reveal = '';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'journal-open';
    open.setAttribute('aria-label', `Рассмотреть: ${item.title}`);
    if (item.images?.length) {
      const photo = document.createElement('div'); photo.className = 'journal-cover';
      const img = document.createElement('img'); img.src = item.images[0]; img.alt = item.title; img.loading = 'lazy';
      photo.append(img);
      if (item.images.length > 1) { const count = document.createElement('span'); count.className = 'photo-count'; count.textContent = `${item.images.length} фото`; photo.append(count); }
      open.append(photo);
    }
    const copy = document.createElement('div'); copy.className = 'journal-card-copy';
    if (key === 'events' && item.date) { const date = document.createElement('time'); date.dateTime = item.date; date.textContent = eventDate(item.date); copy.append(date); }
    const title = document.createElement('h3'); title.textContent = item.title; copy.append(title);
    if (item.text) { const text = document.createElement('p'); text.textContent = item.text; copy.append(text); }
    const more = document.createElement('span'); more.className = 'text-link'; more.textContent = item.images?.length ? 'Рассмотреть историю ↗' : 'Читать историю ↗'; copy.append(more);
    open.append(copy); card.append(open); target.append(card);
    open.addEventListener('click', () => {
      $('#journal-title').textContent = item.title; $('#journal-text').textContent = item.text;
      $('#journal-date').textContent = key === 'events' && item.date ? eventDate(item.date) : key === 'reviews' ? 'Фото и отзывы покупательниц' : 'Проект Фарфории';
      $('#journal-source').hidden = !item.source; $('#journal-source').href = item.source || pageContent.sections.telegram;
      renderGallery($('#journal-gallery'), item.images || [], item.title);
      $('#journal-dialog').showModal(); animateDialog($('#journal-dialog'));
    });
  });
}
const formatDate = date => new Date(date + 'T12:00:00').toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:'numeric'});
const eventDate = date => `${new Date(date + 'T23:59:59') < new Date() ? 'Из архива · ' : ''}${formatDate(date)}`;
renderJournal('reviews'); renderJournal('events');

function renderGallery(target, images, title) {
  target.replaceChildren(); target.hidden = !images.length;
  if (!images.length) return;
  let index = 0;
  const stage = document.createElement('div'); stage.className = 'gallery-stage';
  const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'gallery-photo'; zoom.setAttribute('aria-label', 'Рассмотреть фотографию крупнее');
  const image = document.createElement('img'); image.alt = title; zoom.append(image); stage.append(zoom);
  const error = document.createElement('p'); error.className = 'gallery-error'; error.hidden = true; error.textContent = 'Фото не загрузилось. Попробуйте другой снимок или откройте публикацию мастера.'; stage.append(error);
  image.addEventListener('error', () => { error.hidden = false; }); image.addEventListener('load', () => { error.hidden = true; });
  const controls = document.createElement('div'); controls.className = 'gallery-controls'; controls.hidden = images.length < 2;
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '←'; previous.setAttribute('aria-label','Предыдущая фотография');
  const status = document.createElement('span'); status.setAttribute('aria-live','polite');
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '→'; next.setAttribute('aria-label','Следующая фотография');
  controls.append(previous,status,next);
  const thumbs = document.createElement('div'); thumbs.className = 'gallery-thumbs'; thumbs.hidden = images.length < 2; thumbs.setAttribute('role','group'); thumbs.setAttribute('aria-label','Фотографии');
  const buttons = images.map((url,i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label',`Фото ${i+1}`);
    const img = document.createElement('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; b.append(img); b.addEventListener('click', () => show(i)); thumbs.append(b); return b;
  });
  function show(i) {
    index = (i + images.length) % images.length; error.hidden = true; image.src = images[index]; image.alt = `${title}. Фото ${index+1} из ${images.length}`;
    status.textContent = `${index+1} / ${images.length}`;
    buttons.forEach((button,i) => button.setAttribute('aria-pressed',String(i === index)));
  }
  previous.addEventListener('click', () => show(index-1)); next.addEventListener('click', () => show(index+1));
  target.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(index+(event.key === 'ArrowLeft' ? -1 : 1)); } };
  let touch, swipedAt = 0;
  stage.addEventListener('touchstart', event => { const t = event.changedTouches[0]; touch = {x:t.clientX,y:t.clientY}; }, {passive:true});
  stage.addEventListener('touchend', event => {
    if (!touch) return;
    const t = event.changedTouches[0]; const dx=t.clientX-touch.x, dy=t.clientY-touch.y;
    if (Math.abs(dx)>48 && Math.abs(dx)>Math.abs(dy)*1.5) { swipedAt = Date.now(); show(index+(dx<0?1:-1)); } touch=null;
  }, {passive:true});
  zoom.addEventListener('click', () => {
    if (Date.now() - swipedAt < 400) return;
    $('#photo-large').src = images[index]; $('#photo-large').alt = image.alt;
    $('#photo-zoom').classList.remove('is-zoomed'); $('#photo-zoom').setAttribute('aria-pressed','false'); $('#photo-zoom').setAttribute('aria-label','Увеличить фотографию');
    $('#photo-dialog').showModal();
  });
  target.append(stage, controls, thumbs); show(0);
}
$('#photo-zoom').addEventListener('click', () => {
  const zoom = $('#photo-zoom'); const active = zoom.classList.toggle('is-zoomed');
  zoom.setAttribute('aria-pressed',String(active)); zoom.setAttribute('aria-label',active ? 'Уменьшить фотографию' : 'Увеличить фотографию');
});

works.forEach((work, index) => {
  const card = document.createElement('article');
  card.className = 'work-card';
  card.dataset.reveal = '';
  card.dataset.types = work.types.join(' ');
  card.style.setProperty('--reveal-delay', `${index % 3 * 80}ms`);
  card.innerHTML = `<button type="button" class="work-photo media" data-work="${index}" aria-label="Рассмотреть: ${escapeHTML(work.name)}"><img src="${escapeHTML(work.image)}" alt="${escapeHTML(work.name)}, украшение Ирины Маркиной" loading="lazy" width="600" height="750"><span class="image-fallback" hidden>Фото не загрузилось. Откройте карточку, чтобы перейти к публикации.</span><span class="work-category">${escapeHTML(work.category)}</span><span class="work-open">Подробнее${arrow}</span></button><div class="work-info"><div><h3>${escapeHTML(work.name)}</h3><p>${escapeHTML(work.detail)}</p></div><span>${String(index + 1).padStart(2, '0')}</span></div>`;
  grid.append(card);
});

$$('.media img').forEach(img => {
  const media = img.closest('.media');
  const loaded = () => media.classList.add('is-loaded');
  const failed = () => {
    img.hidden = true;
    const fallback = media.querySelector('.image-fallback');
    if (fallback) fallback.hidden = false;
  };
  img.addEventListener('load', loaded, { once: true });
  img.addEventListener('error', failed, { once: true });
  if (img.complete) img.naturalWidth > 0 ? loaded() : failed();
});

const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-visible');
    revealObserver.unobserve(entry.target);
  });
}, { threshold: .12 });
document.body.classList.add('motion-ready');
$$('[data-reveal]').forEach(el => revealObserver.observe(el));

$$('[data-filter]').forEach(button => button.addEventListener('click', () => {
  const filter = button.dataset.filter;
  $$('[data-filter]').forEach(other => {
    const selected = other === button;
    other.classList.toggle('is-current', selected);
    other.setAttribute('aria-pressed', String(selected));
  });
  $$('.work-card').forEach(card => {
    card.hidden = filter !== 'all' && !card.dataset.types.split(' ').includes(filter);
    if (!card.hidden) {
      card.classList.add('is-visible');
      if (!reduceMotion.matches) card.animate([
        { opacity: 0, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 500, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
  });
  $('#empty-state').hidden = $$('.work-card').some(card => !card.hidden);
}));

// The photograph is the story: an outfit and its corresponding piece change together.
// The page background never moves. Only the photo layers crossfade inside their clips.
const stories = pageContent.stories;
let currentStory = 0;
let storyTimer;
let stageVisible = false;
let manuallyPaused = false;
let hovered = false;
const stage = $('.hero-stage');
const pauseButton = $('#pause-slides');
function syncStories() {
  clearTimeout(storyTimer);
  const paused = manuallyPaused || reduceMotion.matches;
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.setAttribute('aria-label', reduceMotion.matches
    ? 'Автоматическая смена фото отключена настройкой уменьшения движения'
    : paused ? 'Продолжить смену фото' : 'Приостановить смену фото');
  pauseButton.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  pauseButton.disabled = reduceMotion.matches;
  if (!paused && stageVisible && !hovered && !document.hidden) {
    storyTimer = setTimeout(() => {
      showStory((currentStory + 1) % stories.length);
      syncStories();
    }, 5500);
  }
}
function showStory(index) {
  currentStory = index;
  $$('[data-slide-image]').forEach((image, i) => {
    image.classList.toggle('is-current', i === index);
    image.setAttribute('aria-hidden', String(i !== index));
  });
  $$('[data-detail-image]').forEach((image, i) => {
    image.classList.toggle('is-current', i === index);
    image.setAttribute('aria-hidden', String(i !== index));
  });
  $$('[data-slide]').forEach((button, i) => {
    button.classList.toggle('is-current', i === index);
    button.setAttribute('aria-pressed', String(i === index));
  });
  const work = stories[index];
  $('#hero-work-name').textContent = work.name;
  $('#slide-current').textContent = `0${index + 1}`;
  $('#hero-publication').href = work.source;
  $('#hero-publication').setAttribute('aria-label', `Публикация мастера: ${work.name}`);
}
new IntersectionObserver(entries => {
  stageVisible = entries[0].isIntersecting;
  syncStories();
}, { threshold: .3 }).observe(stage);
$$('[data-slide]').forEach(button => button.addEventListener('click', () => {
  showStory(Number(button.dataset.slide));
  syncStories();
}));
pauseButton.addEventListener('click', () => { manuallyPaused = !manuallyPaused; syncStories(); });
stage.addEventListener('mouseenter', () => { hovered = true; syncStories(); });
stage.addEventListener('mouseleave', () => { hovered = false; syncStories(); });
stage.addEventListener('focusin', () => { hovered = true; syncStories(); });
stage.addEventListener('focusout', event => {
  if (!stage.contains(event.relatedTarget)) { hovered = false; syncStories(); }
});
document.addEventListener('visibilitychange', syncStories);
reduceMotion.addEventListener('change', syncStories);
showStory(0);
syncStories();

// Word activation is tied to scroll progress, rather than replaying a timed headline loop.
const tagline = $('.tagline-text');
$$('.tagline-line').forEach(line => {
  const words = line.textContent.split(' ');
  line.replaceChildren(...words.flatMap((word, index) => {
    const span = document.createElement('span');
    span.className = 'tagline-word';
    span.textContent = word;
    return index ? [document.createTextNode(' '), span] : [span];
  }));
});
const taglineWords = $$('.tagline-word');
let taglineVisible = false;
let pendingTaglineFrame = false;
function paintTagline() {
  pendingTaglineFrame = false;
  const box = tagline.getBoundingClientRect();
  const progress = Math.max(0, Math.min(1, (innerHeight * .85 - box.top) / (box.height + innerHeight * .15)));
  taglineWords.forEach((word, i) => word.classList.toggle('is-lit', reduceMotion.matches || progress >= i / taglineWords.length));
}
const taglineObserver = new IntersectionObserver(entries => {
  taglineVisible = entries[0].isIntersecting;
  if (taglineVisible) paintTagline();
});
taglineObserver.observe(tagline);
window.addEventListener('scroll', () => {
  if (taglineVisible && !pendingTaglineFrame) {
    pendingTaglineFrame = true;
    requestAnimationFrame(paintTagline);
  }
}, { passive: true });
window.addEventListener('resize', () => { if (taglineVisible) paintTagline(); });
reduceMotion.addEventListener('change', paintTagline);

const enteringDialogs = new WeakMap();
const closingDialogs = new WeakMap();
function animateDialog(dialog) {
  if (reduceMotion.matches) return;
  const animation = dialog.animate([
    { opacity: 0, transform: 'translateY(24px) scale(.985)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration: 500, easing: 'cubic-bezier(.22,1,.36,1)' });
  enteringDialogs.set(dialog, animation);
  animation.finished.then(() => {
    if (enteringDialogs.get(dialog) === animation) enteringDialogs.delete(dialog);
  }).catch(() => {});
}
function closeDialog(dialog) {
  if (!dialog.open) return Promise.resolve();
  if (closingDialogs.has(dialog)) return closingDialogs.get(dialog);
  const finished = (async () => {
    if (reduceMotion.matches) { dialog.close(); return; }
    const style = getComputedStyle(dialog);
    const from = { opacity: style.opacity, transform: style.transform };
    enteringDialogs.get(dialog)?.cancel();
    enteringDialogs.delete(dialog);
    dialog.classList.add('is-closing');
    const animation = dialog.animate([
      from,
      { opacity: 0, transform: 'translateY(16px) scale(.985)' },
    ], { duration: 500, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
    try { await animation.finished; } catch { /* Finish closing if the animation is cancelled. */ }
    dialog.close();
    animation.cancel();
    dialog.classList.remove('is-closing');
  })().finally(() => closingDialogs.delete(dialog));
  closingDialogs.set(dialog, finished);
  return finished;
}
$$('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
$$('dialog').forEach(dialog => dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeDialog(dialog);
}));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog || dialog.classList.contains('mobile-menu')) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
}));
const workDialog = $('#work-dialog');
let selectedWork = works[0];
$$('[data-work]').forEach(button => button.addEventListener('click', () => {
  selectedWork = works[Number(button.dataset.work)];
  renderGallery($('#work-gallery'), [selectedWork.image, ...(selectedWork.images || []).filter(url => url !== selectedWork.image)], selectedWork.name);
  $('#work-title').textContent = selectedWork.name;
  $('#work-type').textContent = `${selectedWork.category} · ${selectedWork.detail}`;
  $('#work-description').textContent = selectedWork.description;
  $('#work-source').href = selectedWork.source || pageContent.sections.telegram;
  $('#work-source').hidden = !selectedWork.source;
  workDialog.showModal();
  animateDialog(workDialog);
}));
$('#choose-work').addEventListener('click', async () => {
  $('#selected-work').value = selectedWork.id;
  $('#message-result').hidden = true;
  await closeDialog(workDialog);
  $('#contact').scrollIntoView({ behavior: scrollBehavior() });
  $('#wishes').focus({ preventScroll: true });
});

const menuDialog = $('#mobile-menu');
const menuToggle = $('.menu-toggle');
menuToggle.addEventListener('click', () => {
  if (menuDialog.open) { closeDialog(menuDialog); return; }
  menuToggle.setAttribute('aria-expanded', 'true');
  menuToggle.setAttribute('aria-label', 'Закрыть меню');
  menuDialog.showModal();
  animateDialog(menuDialog);
  requestAnimationFrame(() => menuDialog.classList.add('is-open'));
});
menuDialog.addEventListener('close', () => {
  menuDialog.classList.remove('is-open');
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Открыть меню');
});
$$('#mobile-menu nav a').forEach(link => link.addEventListener('click', async event => {
  event.preventDefault();
  await closeDialog(menuDialog);
  if (location.hash !== link.hash) location.hash = link.hash;
  else $(link.hash)?.scrollIntoView({ behavior: scrollBehavior() });
}));
matchMedia('(min-width:801px)').addEventListener('change', event => { if (event.matches && menuDialog.open) closeDialog(menuDialog); });
const navObserver = new IntersectionObserver(entries => entries.forEach(entry => {
  if (!entry.isIntersecting) return;
  $$('.desktop-links a').forEach(link => {
    if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}), { rootMargin: '-20% 0px -60% 0px' });
['#works', '#maker', '#reviews', '#events', '#questions'].forEach(id => navObserver.observe($(id)));

$('#contact-form').addEventListener('submit', event => {
  event.preventDefault();
  const wishes = $('#wishes');
  if (!wishes.value.trim()) {
    $('#wishes-error').textContent = 'Напишите несколько слов о вашем украшении, чтобы подготовить сообщение.';
    $('#wishes-error').hidden = false;
    wishes.setAttribute('aria-invalid', 'true');
    wishes.focus();
    return;
  }
  wishes.removeAttribute('aria-invalid');
  $('#wishes-error').hidden = true;
  const work = works.find(item => item.id === $('#selected-work').value);
  $('#message-text').value = [
    'Ирина, здравствуйте! Увидела ваши украшения на сайте «Фарфория».',
    `Мне интересно: ${work?.name || $('#selected-work').value}.`,
    work?.source ? `Понравилась работа: ${work.source}` : '',
    $('#occasion').value.trim() ? `Повод: ${$('#occasion').value.trim()}` : '',
    `Мои пожелания: ${wishes.value.trim()}`,
    'Подскажите, пожалуйста, возможность заказа, стоимость, сроки и способ получения.',
  ].filter(Boolean).join('\n\n');
  $('#message-result').hidden = false;
  $('#copy-status').textContent = 'Сообщение подготовлено. Скопируйте его и отправьте Ирине в диалоге.';
  $('#message-result').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
});
$('#contact-form').addEventListener('input', event => {
  if (event.target.id !== 'message-text') $('#message-result').hidden = true;
  if (event.target.id === 'wishes' && event.target.value.trim()) {
    $('#wishes-error').hidden = true;
    event.target.removeAttribute('aria-invalid');
  }
});
$('#selected-work').addEventListener('change', () => { $('#message-result').hidden = true; });
$('#copy-message').addEventListener('click', async () => {
  const field = $('#message-text');
  try {
    await navigator.clipboard.writeText(field.value);
    $('#copy-status').textContent = 'Текст скопирован. Откройте диалог VK, вставьте сообщение и отправьте его Ирине.';
  } catch {
    field.focus();
    field.select();
    $('#copy-status').textContent = 'Не удалось скопировать автоматически. Текст выделен, скопируйте его вручную.';
  }
});

const info = {
  privacy: { title: 'Конфиденциальность', paragraphs: [
    'Текст обращения подготавливается в вашем браузере. Сайт не отправляет его Ирине автоматически и не сохраняет заявки на сервере.',
    'Веб сервер ведёт стандартный журнал обращений. Он может содержать IP адрес, время запроса, адрес страницы и сведения о браузере.',
    'На сайте используется Яндекс.Метрика: статистика посещений, карта кликов и Вебвизор. Сервис получает технические сведения о посещении и действиях на сайте и может использовать cookies. Содержимое полей обращения скрыто от записи Вебвизора.',
    'Шрифт загружается из Google Fonts. Ссылки на VK, Telegram и Instagram открывают внешние сервисы, где действуют их собственные правила обработки данных.',
    'Форма не запрашивает платёжные данные. Не указывайте в ней информацию, которую не хотите передавать в личном диалоге с мастером.',
  ] },
  terms: { title: 'Условия обращения', paragraphs: [
    'На странице представлены примеры работ Ирины Маркиной. Галерея не подтверждает наличие украшения или возможность его точного повтора.',
    'Подготовка сообщения не оформляет заказ. Стоимость, материалы, сроки, оплату и способ получения необходимо согласовать непосредственно с мастером.',
    `Контакты и фотографии взяты из авторского канала «Фарфория». Уточнить актуальные условия можно по телефону ${pageContent.sections.phoneLabel} или в личном диалоге VK.`,
  ] },
};
$$('[data-info]').forEach(button => button.addEventListener('click', () => {
  const content = info[button.dataset.info];
  $('#info-title').textContent = content.title;
  $('#info-content').replaceChildren(...content.paragraphs.map(text => {
    const p = document.createElement('p'); p.textContent = text; return p;
  }));
  $('#info-dialog').showModal();
  animateDialog($('#info-dialog'));
}));
