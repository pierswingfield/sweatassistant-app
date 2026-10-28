const assert = require('assert');
const MarianaTek = require('./providers/marianatek');

(async () => {
  const provider = new MarianaTek({ id: 'fixture', apiBaseUrl: 'https://fixture.invalid/api/customer/v1', allowedRegionIds: ['1', '2'] });
  const requests = [];
  provider.classListRequest = async (path) => {
    const url = new URL(path, 'https://fixture.invalid');
    const region = url.searchParams.get('region');
    requests.push(region);
    return { ok: true, json: async () => ({ results: [
      { id: region, location: { region: { id: region } } },
      { id: 'outside', location: { region: { id: '3' } } },
    ] }) };
  };
  const rows = await provider.sharedClassList({ startDate: '2030-01-01', endDate: '2030-01-02' });
  assert.deepStrictEqual(requests, ['1', '2']);
  assert.deepStrictEqual(rows.map(r => r.id), ['1', '2']);
  assert.throws(() => provider.isClassInScope({ location: {} }), /Cannot verify/);
  assert.strictEqual(provider.isClassInScope({ location: { region: { id: '3' } } }), false);
  provider.request = async () => ({ ok: true, json: async () => ({ results: [
    { id: 'in', class_session: { location: { region: { id: '1' } } } },
    { id: 'out', class_session: { location: { region: { id: '3' } } } },
    { id: 'unknown', class_session: { location: {} } },
  ] }) });
  await provider.assertReservationInScope('in', { accessToken: 'fixture' });
  await assert.rejects(() => provider.assertReservationInScope('out', { accessToken: 'fixture' }), /outside/);
  await assert.rejects(() => provider.assertReservationInScope('unknown', { accessToken: 'fixture' }), /Cannot verify/);
  console.log('Mariana Tek configured region scope passed');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
