export function formatQaMessage({ questions = [], summary = '' }) {
  const items = questions.map(item => item.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const note = summary.trim();
  // Older requests may have only a summary.
  if (!items.length) return note;
  const list = items.map((item, i) => `${i + 1}. ${item}`).join('\n');
  return `请补充：\n${list}${note ? `\n\n补充说明：\n${note}` : ''}`;
}
