// Keep in sync with src/team/laneKey.ts
const SYNONYMS = {
  todo: ['todo', 'to do', 'to-do', 'backlog', 'new', 'open', 'planned', 'next', 'inbox',
    'к выполнению', 'сделать', 'надо сделать', 'нужно сделать', 'задачи', 'запланировано', 'бэклог', 'новые',
    'qilish kerak', 'rejada', 'yangi', 'bajarilishi kerak'],
  inprogress: ['in progress', 'doing', 'wip', 'working', 'started', 'active', 'ongoing', 'in work',
    'в работе', 'в процессе', 'делается', 'выполняется', 'в разработке',
    'jarayonda', 'bajarilmoqda', 'ishda'],
  review: ['review', 'in review', 'testing', 'qa', 'check', 'на проверке', 'ревью', 'тестирование', 'проверка',
    'tekshiruvda', 'tekshirish'],
  done: ['done', 'complete', 'completed', 'finished', 'closed', 'готово', 'сделано', 'выполнено', 'завершено',
    'закрыто', 'tayyor', 'bajarildi', 'tugallandi'],
};

function squash(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{Extended_Pictographic}\p{M}\p{P}\p{S}\p{Z}\s_]+/gu, '');
}

const LOOKUP = new Map();
for (const [key, words] of Object.entries(SYNONYMS)) for (const w of words) LOOKUP.set(squash(w), key);

/** Canonical key for a list title: emoji/spacing/case-insensitive, with status synonyms. */
export function laneKey(title) {
  const s = squash(title);
  return LOOKUP.get(s) || s;
}
