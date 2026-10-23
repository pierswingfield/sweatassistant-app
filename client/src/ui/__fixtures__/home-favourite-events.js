// Safe visual fixture. The instructor URLs are the published, sanitized
// MarianaTek values from server/__fixtures__/marianatek/classes-list.json;
// dates and normalized fields are moved into the next seven-day window.
export const HOME_FAVOURITE_EVENTS = [
  {
    id: 'fixture-jab-nickol', gymId: 'jab-boxing', studioId: '6282',
    name: 'TRAIN - Core & Glutes', discipline: 'TRAIN',
    studioName: 'TRAIN', locationName: 'SW1',
    startAt: '2026-10-14T07:30:00+01:00', timeZone: 'Europe/London',
    releaseAt: '2026-10-01T06:30:00+01:00', availableCount: 5, capacity: 40,
    instructors: [{ id: '6255', name: 'Nickol', thumbUrl: 'https://mtproduction-files.s3.amazonaws.com/media/public_images/2_r9cgZUz.png' }],
  },
  {
    id: 'fixture-jab-elsa', gymId: 'jab-boxing', studioId: '6286',
    name: 'BOXING Drills & Endurance', discipline: 'BOXING',
    studioName: 'BOXING', locationName: 'SW1',
    startAt: '2026-10-15T18:30:00+01:00', timeZone: 'Europe/London',
    releaseAt: '2026-10-02T06:30:00+01:00', availableCount: 1, capacity: 40,
    instructors: [{ id: '7195', name: 'Elsa', thumbUrl: 'https://mtproduction-files.s3.amazonaws.com/media/public_images/Screenshot_2026-02-01_at_09.50.26.png' }],
  },
];
