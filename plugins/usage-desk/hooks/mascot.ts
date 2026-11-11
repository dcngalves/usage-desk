// Usage Desk's own mascot: a pixel owl with one outfit per kind of work.
// Original art for this project. The outfit's accent follows the tier colours.
const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  explore: '#1D9E75',
  other: '#888780',
}
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

// The owl sits on a 30×28 grid: a 16×13 body, wings either side, two stepping feet.
const PLUME = '#5B6B8C'
const BELLY = '#E9DFC7'
const SPOT = '#B9AC8E'
const BEAK = '#E0A63A'
const WHITE = '#FBFAF6'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// outfit, `la`/`lb` the two feet, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `wingUp` raises the front wing; `wingCls` lets it travel with the prop it holds.
const owlBody = (f: Fill, wingUp = 0, wingCls?: string): void => {
  f(8, 8, 2, 1, PLUME); f(20, 8, 2, 1, PLUME)
  f(8, 9, 14, 13, PLUME); f(7, 10, 16, 11, PLUME)
  f(9, 11, 4, 4, WHITE); f(17, 11, 4, 4, WHITE)
  f(10, 12, 2, 2, INK); f(18, 12, 2, 2, INK)
  f(14, 14, 2, 2, BEAK)
  f(10, 16, 10, 5, BELLY)
  f(12, 17, 1, 1, SPOT); f(16, 17, 1, 1, SPOT); f(14, 19, 1, 1, SPOT); f(18, 19, 1, 1, SPOT)
  f(4, 14, 3, 5, PLUME)
  f(23, 14 + wingUp, 3, 5, PLUME, wingCls)
  f(10, 22, 1, 2, BEAK, 'la'); f(9, 24, 3, 1, BEAK, 'la')
  f(19, 22, 1, 2, BEAK, 'lb'); f(18, 24, 3, 1, BEAK, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every owl walks;
// each costume adds its prop's own motion on top.
export const MASCOT_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    owlBody(f)
    f(8, 6, 14, 1, '#E6E8EE'); f(6, 7, 2, 1, '#E6E8EE'); f(22, 7, 2, 1, '#E6E8EE')
    f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 7, 18, 15, 'rgba(169,214,245,.3)'); f(8, 8, 1, 3, '#fff')
    f(14, 3, 2, 3, '#C9CCD2'); f(14, 1, 2, 2, t, 'ant'); f(13, 20, 4, 1, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective in a check cap; the magnifier sweeps and glints.
  heavy: (f, t) => {
    owlBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbcb....', '...bbbbbbbbbbbb...', '...tttttttttttt...', '.dddddddddddddddd.', '.d..............d.'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519', t })
    stamp(f, 24, 2, ['.kk.', 'k..k', 'k..k', '.kk.'], { k: '#3A3A3C' }, 'it')
    f(25, 3, 2, 2, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(25, 3, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    owlBody(f)
    stamp(f, 6, 4, ['......yyyyyy......', '....yyyyhhyyyy....', '...yyyyyhhyyyyy...', '...yyyyyhhyyyyy...', '.dddddddddddddddd.'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(10, 6, 2, 2, t)
    stamp(f, 3, 10, ['s.s', 'sss', '.s.', '.s.'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef in a puffed hat; tosses the omelette.
  medium: (f, t) => {
    owlBody(f, -4, 'pan')
    stamp(f, 7, 3, ['...ww..ww..ww...', '..wwwwwwwwwwww..', '.wwwwgwwwwgwwww.', '.wwwwwwwwwwwwww.', '..wwwwwwwwwwww..', '..bbbbbbbbbbbb..', '..bbbbbbbbbbbb..'], { w: '#F4F3EE', g: '#D2D1C8', b: t })
    f(23, 8, 6, 1, '#4A4A48', 'pan'); f(24, 9, 1, 2, '#4A4A48', 'pan'); f(25, 7, 2, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    owlBody(f, -4)
    stamp(f, 6, 5, ['.....rrrrrrrr.....', '...rrrrwwrrrrrr...', '..rrrrrwwrrrrrrr..', '..rrrrrwwrrrrrrr..', '..kkkkkkkkkkkkkk..'], { r: t, w: '#F8F6F1', k: INK })
    f(26, 1, 1, 9, '#8E929A')
    stamp(f, 27, 1, ['wkw', 'kwk', 'wkw'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    owlBody(f)
    stamp(f, 5, 4, ['........kkkk........', '.....kkkkkkkkkk.....', '..kkkkkkkwwkkkkkkk..', '.kkkkkkkkkkkkkkkkkk.', '..gggggggggggggggg..'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(8, 10, 9, 1, INK); f(17, 11, 4, 4, INK)
    f(26, 6, 1, 9, '#C9CCD2', 'it'); f(25, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => owlBody(f),
}

const MASCOT_BOX = 30
const MASCOT_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// feet stay outside it and step on their own. `mirror` flips the owl inside its
// own box (x .. x + MASCOT_BOX * scale) so it faces left.
export const mascot = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = MASCOT_SCALE, mirror = false): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => owlBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + MASCOT_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}
