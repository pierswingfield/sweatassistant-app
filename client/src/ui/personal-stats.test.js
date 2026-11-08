import { describe, it, expect, vi } from 'vitest';
import { renderPersonalStats, personalStatsNotes } from './personal-stats.js';
import { gymsWithPreferredSlots, enableAutoUpgradeForGyms } from './onboarding-routing.js';
import { COPY } from '../copy.js';
const fixture = (extra={}) => ({ totalPastClasses: 1, streak: { weeks:1,atLeast:false }, partial:false,pending:false, coverage:[],volume:{points:Array.from({length:30},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,count:i===29?1:0}))},patterns:{weekdays:[1,0,0,0,0,0,0],timeBins:[0,0,1,0,0,0],gymMix:[{gymId:'a',count:1,percent:100}]},...extra });
describe('private history chart presentation',()=>{
 it('renders four distinct period-labelled charts and all accessible daily values',()=>{const el=document.createElement('div');renderPersonalStats(el,fixture());expect([...el.querySelectorAll('.personal-chart h4')].map(e=>e.textContent)).toEqual([COPY.home.statsTrainingVolume,COPY.home.statsBusiestDays,COPY.home.statsGymMix,COPY.home.statsBusiestTimes]);expect(el.querySelectorAll('circle[tabindex]')).toHaveLength(30);expect(el.querySelectorAll('tbody tr')).toHaveLength(30);expect(el.textContent).toContain('100%');expect(el.textContent).not.toContain('attendance');});
 it('never presents unavailable history as a definite zero streak or empty success',()=>{const el=document.createElement('div');renderPersonalStats(el,fixture({totalPastClasses:0,pending:true,coverage:[{state:'pending'}]}));expect(el.querySelector('.personal-streak')).toBeNull();expect(el.textContent).toContain(COPY.home.statsImporting);expect(el.textContent).not.toContain(COPY.home.statsEmptyHistory);renderPersonalStats(el,fixture({totalPastClasses:0}));expect(el.textContent).toContain(COPY.home.statsEmptyHistory);});
 it('preserves charts and labels lower-bound streak for partial coverage; retries via callback',()=>{const el=document.createElement('div'),retry=vi.fn();renderPersonalStats(el,fixture({partial:true,streak:{weeks:1,atLeast:true},coverage:[{state:'failed'}]}),{retry});expect(el.querySelectorAll('.personal-chart')).toHaveLength(4);expect(el.textContent).toContain('At least');el.querySelector('[data-stats-retry]').click();expect(retry).toHaveBeenCalledOnce();expect(personalStatsNotes(fixture({coverage:[{state:'disabled',limited:true}]}))).toEqual([COPY.home.statsDisabled,COPY.home.statsLimited]);});
});
describe('saved preferred slots gate onboarding enablement',()=>{
 const links=[{gym_id:'a'},{gym_id:'b'},{gym_id:'off',account_enabled:0},{gym_id:'unsupported'}];const catalogue=[{id:'a'},{id:'b'},{id:'off'},{id:'unsupported',capabilities:{autoUpgrade:false}}];
 it('rejects empty/row-only/failed/disabled/noneligible maps and prevents studio ID collision',()=>{expect(gymsWithPreferredSlots(links,catalogue,{a:{'1':{preferredRows:['front']}},b:{'1':{preferredSlots:['9']}},off:{'1':{preferredSlots:['9']}},unsupported:{'1':{preferredSlots:['9']}}})).toEqual(['b']);expect(gymsWithPreferredSlots(links,catalogue,{})).toEqual([]);});
 it('persists only eligible gyms and reports rejected saves without inventing success',async()=>{const save=vi.fn().mockRejectedValue(new Error('fail'));const result=await enableAutoUpgradeForGyms(links,catalogue,save,['b']);expect(save).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledWith({autoUpgradeEnabled:true},'b');expect(result).toEqual({enabledGymIds:[],failedGymIds:['b']});});
});

describe('saved favourites visibility uses saved state, independent of schedule',()=>{
 it('hides confirmed global zero and keeps failed or not loaded gyms unknown',async()=>{
   window.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
   const {savedFavouritesVisibility}=await import('./home.js');
   expect(savedFavouritesVisibility(['a','b'],{a:{items:[]},b:{items:[]}})).toBe('hidden');
   expect(savedFavouritesVisibility(['a','b'],{a:{items:[]}})).toBe('unknown');
   expect(savedFavouritesVisibility(['a','b'],{a:{items:[{id:'saved-no-schedule-match'}]}})).toBe('visible');
   expect(savedFavouritesVisibility(['a'],{a:{items:[]},b:{items:[{id:'unlinked'}]}})).toBe('hidden');
 });
});
