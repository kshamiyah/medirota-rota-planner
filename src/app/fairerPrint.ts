/** Fit each complete week onto its landscape A4 sheet, including the first-page summary. */
export function fitFairerPrint(root: HTMLElement) {
  const sheets = Array.from(root.querySelectorAll<HTMLElement>('.fairer-print-week'));
  for (const sheet of sheets) sheet.style.removeProperty('zoom');
  // beforeprint runs with print styles active. Leave a little room for rounding at page edges.
  const availableHeight = 188 * 96 / 25.4;
  for (const sheet of sheets) {
    const height = sheet.getBoundingClientRect().height;
    if (height > availableHeight) sheet.style.zoom = String(availableHeight / height);
  }
}
