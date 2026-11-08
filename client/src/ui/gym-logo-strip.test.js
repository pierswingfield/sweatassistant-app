import { describe, it, expect, vi } from 'vitest';
import { startGymLogoDiscovery } from './gym-logo-strip.js';
describe('continuous studio marquee',()=>{
 it('keeps a decoded linear infinite animation and persistent keyboard/pointer pause on one node',async()=>{
   window.matchMedia=()=>({matches:false,addEventListener(){}});
   const el=document.createElement('div');el.innerHTML='<div class="app-onb-gym-logos-track"><ul class="app-onb-gym-logos-set"></ul><ul class="app-onb-gym-logos-set" aria-hidden="true"></ul></div>';document.body.append(el);
   el.querySelector('ul').getBoundingClientRect=()=>({width:750});const anim={pause:vi.fn(),play:vi.fn()};const animate=vi.fn().mockReturnValue(anim);el.querySelector('div').animate=animate;
   await startGymLogoDiscovery(el);expect(animate.mock.calls[0][1]).toMatchObject({duration:46875,iterations:Infinity,easing:'linear'});
   el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));expect(el.getAttribute('aria-pressed')).toBe('true');
   el.dispatchEvent(new Event('focusout'));expect(el.dataset.paused).toBe('true');
   el.click();expect(el.getAttribute('aria-pressed')).toBe('false');expect(el.dataset.paused).toBe('false');
   await startGymLogoDiscovery(el);expect(animate).toHaveBeenCalledTimes(1);el.remove();
 });
});
