// Load each gym independently: partial timetable caches must never define which
// linked gyms have studios. Metadata and preferences retain their own API caches.
export function loadSpotMapGyms(gyms, api, { onResult, timeoutMs = 20000 } = {}) {
  return Promise.all(gyms.map(async (gym) => {
    const gymId = gym.gym_id || gym.gymId || gym.id;
    let timer;
    try {
      const result = await Promise.race([
        Promise.all([
          api.getMetadata({ gymId, ttlMs: 3600000 }),
          api.getStudioPreferences(gymId),
        ]).then(([metadata, preferences]) => ({ gymId, metadata, preferences })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Loading timed out. Please try again.')), timeoutMs); }),
      ]);
      onResult?.(result);
      return result;
    } catch (error) {
      const result = { gymId, error };
      onResult?.(result);
      return result;
    } finally { clearTimeout(timer); }
  }));
}
