import { describe, it, expect, vi } from 'vitest';
import { startGymLogoDiscovery, setGymLogoDiscoveryVisible } from './gym-logo-strip.js';
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

describe('studio selection visibility', () => {
  const setup = (reduced = false) => {
    window.matchMedia = () => ({ matches: reduced, addEventListener() {} });
    document.body.innerHTML = '<div tabindex="0" id="strip"></div><select id="gym"><option>Studio</option></select><div id="form"></div>';
    const strip = document.getElementById('strip');
    const animations = [];
    strip.animate = vi.fn(() => {
      let finish, reject;
      const animation = { finished: new Promise((a, b) => { finish = a; reject = b; }), cancel: vi.fn(() => reject(new Error('cancelled'))), finish: () => finish() };
      animations.push(animation); return animation;
    });
    return { strip, animations, select: document.getElementById('gym') };
  };
  it('removes an exiting strip from interaction immediately and hides it after the fade', async () => {
    const { strip, animations, select } = setup();
    strip.focus(); setGymLogoDiscoveryVisible(strip, false, { focusTarget: select });
    expect(document.activeElement).toBe(select); expect(strip.inert).toBe(true); expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.hidden).toBe(false); animations[0].finish(); await Promise.resolve(); expect(strip.hidden).toBe(true);
  });
  it('a rapid deselection cancels the old exit and restores discoverability', async () => {
    const { strip, animations } = setup();
    setGymLogoDiscoveryVisible(strip, false); setGymLogoDiscoveryVisible(strip, true);
    animations[0].finish(); await Promise.resolve();
    expect(animations[0].cancel).toHaveBeenCalled(); expect(strip.hidden).toBe(false); expect(strip.inert).toBe(false); expect(strip.hasAttribute('aria-hidden')).toBe(false);
  });
  it('reduced motion hides and restores synchronously without travel or fade', () => {
    const { strip } = setup(true);
    setGymLogoDiscoveryVisible(strip, false); expect(strip.hidden).toBe(true);
    setGymLogoDiscoveryVisible(strip, true); expect(strip.hidden).toBe(false); expect(strip.inert).toBe(false); expect(strip.animate).not.toHaveBeenCalled();
  });
});
