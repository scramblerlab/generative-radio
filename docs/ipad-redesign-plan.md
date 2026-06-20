# iPad-First Visual Redesign — Generative Radio (mobile)

## Context

The app renders a single phone-width column ([RadioPlayer.tsx](mobile/src/components/RadioPlayer.tsx)) that is **portrait-locked** ([app.json:6](mobile/app.json#L6)) and has **zero size-class / orientation handling** (no `useWindowDimensions`, no `Platform.isPad`, no max-width). On an iPad mini 6 this produces a thin centered column with oversized buttons, phone-sized 28pt type, and large dead margins — the reported "ugly" result.

**2026 design direction (researched):** Apple's **Liquid Glass** is the system-wide material for iOS/iPadOS 26 and is **required for App Store apps by Sept 2026** — translucent, refractive panels layered over content, with depth and reduced border noise. The iPad layout doctrine is **size-class-driven, multi-pane** layouts: never a single full-width column on a large screen; in *regular* width use a sidebar/rail + detail, support landscape, and *redistribute* content rather than scale it. This app's iPad mini 6 (A15) runs iPadOS 26, so native glass works on-device.

**User decisions:** (1) **Landscape + adaptive two-pane** layout; (2) **Native Liquid Glass with graceful fallback**; (3) **Full refresh across phone + iPad**; (4) **iPad mini is the primary target** — tune the regular-width layout to the mini's form factor.

**Primary reference device — iPad mini 6:** 744 × 1133 pt (8.3", @2x). Its *shorter* side is **744 pt**, so a naive `>= 768` regular-width threshold would wrongly treat the mini as a phone. The regular layout, two-pane proportions, and type scale below are all tuned to the mini (744pt portrait width / 1133pt landscape width) and degrade gracefully upward to larger iPads. Test devices: iPhone Air (compact) + iPad mini 6 (regular).

**Outcome:** one responsive `RadioPlayer` that shows a Now-Playing hero + glass "Live rail" on iPad landscape, a centered max-width column on iPad portrait, and a restyled glass stack on phone — all from shared tokens and one glass primitive.

---

## Target layouts (visual)

### A. iPad landscape — regular width, two-pane
```
┌──────────────────────────────────────────────────────────────────────┐
│                                       (soft accent glow behind hero)   │
│   ┌───────────────────────────────────┐   ┌──────────────────────┐    │
│   │         NOW PLAYING PANE          │   │   LIVE RAIL (glass)  │    │
│   │     ░░░ GENERATIVE VISUAL ░░░     │   │ ┌──────────────────┐ │    │
│   │     ▆▅▇▃▆▇▅▂▆▇▅▃▆  (animated)     │   │ │ ● ON AIR  · 12 ◉ │ │    │
│   │                                   │   │ │ now:  <title>    │ │    │
│   │        ROCK · (DJ: NOBU)          │   │ │ next: <genre>    │ │    │
│   │      S O N G   T I T L E          │   │ └──────────────────┘ │    │
│   │      ambient · dreamy · 120 BPM   │   │ ┌──────────────────┐ │    │
│   │   ▆▆▆▆▆▆▆▆▆▆░░░░░   1:23 / 3:00   │   │ │ DJ BOOTH         │ │    │
│   │                                   │   │ │ [Generate Tracks]│ │    │
│   │      ⏮     ▶(glass)    ⏭         │   │ │ unlocks in 2:14  │ │    │
│   │                                   │   │ └──────────────────┘ │    │
│   │       👍 12        👎 1           │   │ ┌──────────────────┐ │    │
│   │                                   │   │ │ LIVE ACTIVITY    │ │    │
│   └───────────────────────────────────┘   │ │ · track gen'd ↑  │ │    │
│                                            │ └──────────────────┘ │    │
│   ╭──────────────────────────────────────────────────────────────╮   │
│   │ ● Playing                         PRESENTED BY GENERATIVE RADIO│ ← glass status pill
│   ╰──────────────────────────────────────────────────────────────╯   │
└──────────────────────────────────────────────────────────────────────┘
```

### B. iPad portrait — regular width, centered single column (max-width ≈720)
```
┌──────────────────────────────────────────────┐
│        (centered · generous side margins)     │
│     ┌──────────────────────────────────┐      │
│     │      ░░ GENERATIVE VISUAL ░░      │      │
│     │      ▆▅▇▃▆▇▅▂▆▇▅▃▆  (large)       │      │
│     │         ROCK · (DJ: NOBU)         │      │
│     │       S O N G   T I T L E         │      │
│     │      ambient · dreamy · 120 BPM   │      │
│     │   ▆▆▆▆▆▆▆▆░░░░░   1:23 / 3:00     │      │
│     │       ⏮      ▶      ⏭            │      │
│     │       👍 12         👎 1          │      │
│     └──────────────────────────────────┘      │
│     ┌──────────────────────────────────┐      │
│     │  LIVE RAIL as a glass card        │      │
│     │  on-air · DJ booth · activity     │      │
│     └──────────────────────────────────┘      │
│   ╭──────────────────────────────────────╮    │
│   │ ● Playing                     👥 12   │ ← glass status pill
│   ╰──────────────────────────────────────╯    │
└──────────────────────────────────────────────┘
```

### C. iPhone — compact (today's stack, restyled with tokens + glass)
```
┌────────────────────────┐
│   ░ GENERATIVE VIS ░    │
│   ▆▅▇▃▆▇▅▂  (animated)  │
│     ROCK · DJ:NOBU      │
│      SONG TITLE         │
│    ambient · 120 BPM    │
│  ▆▆▆▆▆░░░   1:23/3:00   │
│    ⏮    ▶    ⏭         │
│    👍 12      👎 1      │
│  ── live activity ──    │
│  [ Generate Your Tracks]│
│ ╭────────────────────╮  │
│ │ ● Playing    👥 12 │  │ ← glass bar
│ ╰────────────────────╯  │
└────────────────────────┘
```

### D. DJ sheet — regular = centered glass sheet (max-width ≈560); compact = glass slide-up
```
        ╭───────────────────────────────╮
        │   YOU'RE THE DJ!    (glass)   │
        │  Genre:  [rock][jazz][lofi]…  │
        │  Emotion / Atmosphere / Instr.│
        │  Language: [EN][JA][instr.]   │
        │  What are you doing? [______] │
        │  DJ name:  [____________]     │
        │   [ Take the Stage ]   Cancel │
        ╰───────────────────────────────╯
```

---

## Implementation

### 1. Responsive foundation — `src/hooks/useLayout.ts` (new)
Single source of truth for adaptivity, built on `useWindowDimensions()` (re-renders on rotation/Split View — the API the app entirely lacks today):
- Returns `{ width, height, isLandscape, sizeClass: 'compact' | 'regular', contentMaxWidth }`.
- `regular` when `min(width,height) >= 700` — **deliberately tuned so iPad mini 6 (744pt short side) is `regular` in both orientations**, matching its real UIKit size class; a `768` cutoff would misclassify the mini. iPhone Air stays `compact`. iPad Split View narrower than ~half collapses to `compact`, which is correct.
- Drives layout branch in `RadioPlayer` and the type/space scale below.

### 2. Design tokens — extend `src/components/theme.ts`
Keep all existing `colors` (the amber `accent` `#f59e0b`, indigo, dark surfaces). **Add:**
- `spacing` scale `{ xs:4, sm:8, md:12, lg:16, xl:24, x2:32, x3:48 }` (replaces the hardcoded 16/20/28 littered through RadioPlayer styles).
- `type(sizeClass)` → font sizes per role, **tuned to iPad mini**, e.g. title `compact:34 / regular:54` (Bebas Neue; 54 reads large on the mini's 8.3" panel without overflowing the hero — larger iPads simply get more breathing room), body/meta/labels scaled to match.
- `glass` tokens: tint `rgba(255,255,255,0.06)`, hairline `rgba(255,255,255,0.10)`, soft shadow, concentric radii `{ rail:28, card:20, control:999 }`. De-emphasize the hard `border`/`border2` lines in favor of glass + shadow.

### 3. Liquid Glass primitive — `src/components/Glass.tsx` (new)
One reusable frosted surface; every translucent panel goes through it. Fallback chain:
- iOS 26+ → `GlassView` from **`expo-glass-effect`** (true native Liquid Glass via `UIVisualEffectView`).
- iOS < 26 → `BlurView` from **`expo-blur`** (frosted approximation).
- Android / `AccessibilityInfo.isReduceTransparencyEnabled()` → solid `colors.surface` View.
Guard with the package's `isLiquidGlassAvailable()`. Used for: Live rail, status pill, DJ sheet, the play button cluster, badges. **Perf note:** research warns against stacking many animated translucent views — cap to these ~4 surfaces; the generative visual stays a normal Animated view, not glass.

### 4. Restructure `RadioPlayer.tsx` into panes (reuse existing markup)
Extract today's inline blocks into composable pieces, then branch on `sizeClass`/`isLandscape`:
- **`src/components/NowPlayingPane.tsx`** — hero: generative visual, badge, title, tags/meta, progress + `mm:ss / mm:ss` time, transport controls, reactions. Lifts the JSX at [RadioPlayer.tsx:237-336](mobile/src/components/RadioPlayer.tsx#L237-L336) plus the badge/countdown logic at [:204-221](mobile/src/components/RadioPlayer.tsx#L204-L221).
- **`src/components/LiveRailPane.tsx`** — glass panel: On-Air status + listener count, DJ booth (`Generate Your Tracks` + countdown, from [:366-382](mobile/src/components/RadioPlayer.tsx#L366-L382)), vertical `ActivityLog`, DJ info row ([:348-364](mobile/src/components/RadioPlayer.tsx#L348-L364)).
- **`RadioPlayer`** becomes the orchestrator: `regular+landscape` → `<Row>` hero(flex 1.6) + rail(fixed **~340**, glass) — sized for the mini's 1133pt landscape width so the hero keeps ~760pt; `regular+portrait` → centered `contentMaxWidth` (**~720**, ≈ mini portrait width so near full-bleed on mini, centered on larger iPad) column, hero card + rail glass card; `compact` → current stacked `ScrollView`, restyled.
- **`src/components/GenerativeVisual.tsx`** — promote the existing `Waveform` ([:15-69](mobile/src/components/RadioPlayer.tsx#L15-L69)) into a larger, lusher animated bar field (more bars, accent→indigo gradient) as the "album art" of a generative-music app. **Keep** its existing `useNativeDriver:false` background-pause (`isBackground`) guard at [:182-194](mobile/src/components/RadioPlayer.tsx#L182-L194) — it prevents the iOS cpulimit kill and must survive the refactor.
- `BottomStatusBar` ([:100-143](mobile/src/components/RadioPlayer.tsx#L100-L143)) → floating **glass status pill** (bottom-center), in all layouts.

### 5. `DJPanel.tsx` — responsive glass sheet
Keep **all** existing data/selection logic (genre fetch [:39-50](mobile/src/components/DJPanel.tsx#L39-L50), keyword grouping, submit). Change only the container: `compact` keeps the slide-up `Modal` but with a `Glass` surface; `regular` renders a centered glass sheet (max-width ≈560) with pill grids flowing 2–3 columns instead of full-width wrap.

### 6. Orientation + native config — `app.json`
- `"orientation": "portrait"` → **`"default"`** (enables landscape; the layout is responsive so phone landscape is fine too).
- Add plugins for the new native modules: `"expo-blur"`, and `expo-glass-effect` per its install docs.
- **Requires a native rebuild** (`npx expo prebuild` + `expo run:ios`) — not a JS-only reload — because orientation + new native modules change the native project.

### 7. Dependencies (`package.json`)
`expo-glass-effect`, `expo-blur` (install via `npx expo install` to match SDK 55). No other new deps — icons (`@expo/vector-icons`) and fonts already present.

---

## Files

| Action | Path | Purpose |
|---|---|---|
| **new** | `mobile/src/hooks/useLayout.ts` | size class / orientation / max-width |
| **new** | `mobile/src/components/Glass.tsx` | Liquid Glass surface + fallbacks |
| **new** | `mobile/src/components/NowPlayingPane.tsx` | hero pane |
| **new** | `mobile/src/components/LiveRailPane.tsx` | glass live rail |
| **new** | `mobile/src/components/GenerativeVisual.tsx` | enlarged animated visual (from `Waveform`) |
| edit | `mobile/src/components/theme.ts` | add `spacing`, `type()`, `glass` tokens |
| edit | `mobile/src/components/RadioPlayer.tsx` | becomes responsive orchestrator |
| edit | `mobile/src/components/DJPanel.tsx` | responsive glass sheet |
| edit | `mobile/app.json` | orientation `default` + plugins |
| edit | `mobile/package.json` | add `expo-glass-effect`, `expo-blur` |

**Reuse, don't rewrite:** `Waveform`/`ActivityLog`/`BottomStatusBar` sub-components, every `colors` token, `useSafeAreaInsets`, the DJ-countdown + badge-label derivations, and all `DJPanel` fetch/selection logic. The unused [GenreSelector.tsx](mobile/src/components/GenreSelector.tsx) stays out of scope.

## Risks
- **cpulimit regression:** the background-pause guard on the animated visual must be preserved — verify no audio-kill in background after refactor.
- **Glass perf:** keep glass surfaces ≲4; don't wrap the animated visual in glass.
- **Reduce-transparency / Android:** must fall back to solid surfaces (built into `Glass.tsx`).
- Landscape unlock means the lock-screen/now-playing and DJ modal must both be checked in landscape.

## Verification
1. `cd mobile && npx expo install expo-glass-effect expo-blur`, then `npx expo prebuild` and `npx expo run:ios --device` (physical iPad mini 6) — JS reload won't pick up orientation/native changes.
2. **iPad mini 6 / iPad mini (A17) simulator (26.5):** portrait (centered column) and landscape (two-pane); confirm native Liquid Glass renders on the rail/status pill/DJ sheet; rotate live and confirm reflow.
3. **iPhone (compact) regression:** stacked layout intact, restyled, glass status bar; background the app mid-track and confirm audio continues (no cpulimit kill) — the Part 2 behavior must be unaffected.
4. **Fallback paths:** an iOS < 26 sim shows blur (not plain) panels; enable Settings → Reduce Transparency and confirm solid surfaces.
5. DJ flow: open sheet in both size classes, submit, confirm `dj_submit` still fires and playback continues.
6. Quick web-app sanity check that shared types/`@radio/shared` usage is untouched (mobile-only change).

## Sources
- [Liquid Glass design language (iOS/iPadOS 26)](https://developer.apple.com/design/) · [MacRumors iOS 26 Liquid Glass](https://www.macrumors.com/guide/ios-26-liquid-glass/) · [Expo GlassEffect docs](https://docs.expo.dev/versions/latest/sdk/glass-effect/) · [callstack/liquid-glass](https://github.com/callstack/liquid-glass)
- iPad layout doctrine: [Design for iPad — Design+Code](https://designcode.io/ios-design-handbook-design-for-ipad/) · [Size Classes guide](https://www.bitcot.com/designing-for-diversity-with-size-classes-layout-swift/)
