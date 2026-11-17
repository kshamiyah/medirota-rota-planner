export function personPage(start: string): string {
  const monday = new Date(`${start}T00:00:00Z`);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const people = [
    { id: '901', name: 'Rowan, Dr', shift: 'Nights CT', session: 4 },
    { id: '902', name: 'Ellis, Dr', shift: 'Elective C-Sections', session: 1 },
  ];
  return `<!doctype html><html><body><select><option value="person-901">Dr Rowan (ST2)</option><option value="person-902">Dr Ellis (ST3)</option></select>${people.map(person => `<table class="rmap-table js-main-rota" data-person="${person.id}" data-rota-date="${start}"><tbody><tr><td><span class="rmap-rota__detail-name">${person.name}</span><div class="js-activity-name">${person.name} ST2</div></td>${days.map(date => `<td id="n-${person.id}-${date}-${person.session}" class="person-slot" data-date="${date}" data-shift_id="${person.session}"><ul>${date === start ? `<li>${person.shift}</li>` : ''}</ul></td>`).join('')}</tr></tbody></table>`).join('')}</body></html>`;
}
