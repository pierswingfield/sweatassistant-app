# Design Brief: Sweat Assistant Mobile Timetable Filtering UX

## 1. Executive Summary & Scope

This specification defines the redesigned timetable filtering user experience for **Sweat Assistant** on mobile viewports (calibrated to the iPhone 17 Pro, 402pt / 1206px logical width). 

### Strict Scope Boundary
> [!IMPORTANT]
> The changes specified herein apply **strictly and exclusively** to the timetable filtering component:
> - **In Scope**: The filter bar DOM container (`#psycle-filter-bar` / `.timetable-filter-bar`), active criteria chips, and the filter bottom-sheet modal.
> - **Out of Scope (Preserved Unchanged)**:
>   - App Header & profile pill (`#psycle-header`, credits counter, notification bell).
>   - Date carousel strip (`.psycle-date-selector`, day pills, month navigator).
>   - Class session cards / timetable rows (`.timetable-card`, `.psycle-table`).
>   - Bottom navigation bar (`.bottom-nav`).

---

## 2. Visual Design Reference & Previews

### 2.1 Collapsed Filter Bar (Standard Active State)
> Features the 32px circular icon trigger, integrated 1:1 image logo initials tile, active workout pill, single instructor headshot avatar pill, and bookmark toggle.

![Collapsed Filter Bar — Standard](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_collapsed_preview_crop.png)
- **High-Res Crop**: [final_collapsed_preview_crop.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_collapsed_preview_crop.png)
- **Full Device Viewport**: [final_collapsed_preview_viewport.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_collapsed_preview_viewport.png)

### 2.2 Collapsed Filter Bar (Overflow / Many Locations State)
> Demonstrates dynamic count compression `(P) 3 · (J) 2` when 3+ studios are selected for a gym.

![Collapsed Filter Bar — Overflow](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/v1_tight_many_crop.png)
- **High-Res Crop**: [v1_tight_many_crop.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/v1_tight_many_crop.png)
- **Full Device Viewport**: [v1_tight_many_viewport.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/v1_tight_many_viewport.png)

### 2.3 Expanded Bottom Sheet Modal (Gym > Location Structure)
> Hierarchical brand drawer with studio checkboxes, real-time matching class counts, clean logo plates (no colored dots), and "Workouts" terminology.

![Expanded Filter Sheet Modal](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_expanded_preview_crop.png)
- **High-Res Crop**: [final_expanded_preview_crop.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_expanded_preview_crop.png)
- **Full Device Viewport**: [final_expanded_preview_viewport.png](file:///Users/pierswingfield/.gemini/antigravity/brain/5a0b1989-7d37-4876-8bdf-7c3aa4ce0ae9/screenshots/final_expanded_preview_viewport.png)

---

## 3. Architecture & Interaction Model

```mermaid
flowchart TD
    subgraph Collapsed State [Single-Row Collapsed Filter Bar (40px Height)]
        Master["[ 🎛️ ] Master Trigger (32px Circle)"]
        GymTile["[ (P) OC, NH · (J) SW1 ✕ ] Integrated Gym + Studio Tile"]
        WorkoutPill["[ 🚴 Ride ✕ ] Workout / Class Type Pill"]
        InstructorPill["[ (Avatar) Fae ✕ ] Active Instructor Pill (Conditional)"]
        FavToggle["[ ♡ ] Quick Bookmark Toggle"]
    end

    subgraph Expanded State [Bottom Sheet Drawer Modal]
        SheetHeader["Header: Filters · [3 Active] · Reset All · ✕ Close"]
        QuickTabs["Jump Tabs: Gyms (2) · Locations (3) · Workouts (1) · Instructors (1)"]
        GymSection["Gym > Studio Hierarchy Cards (Psycle & JAB)"]
        WorkoutSection["Workouts & Formats Grid"]
        InstructorSection["Instructor Multi-Select List with Headshots"]
    end

    Master -->|Tap| Expanded State
    GymTile -->|Tap Body| Expanded State
    GymTile -->|Tap ✕| ClearGyms["Clear Gym & Location Filters"]
    WorkoutPill -->|Tap ✕| ClearWorkouts["Clear Workout Filters"]
    InstructorPill -->|Tap ✕| ClearInstructor["Clear Instructor Filter"]
    FavToggle -->|Tap| ToggleBookmarks["Toggle Bookmarked Classes"]
```

---

## 4. Collapsed Filter Bar Specification

### 4.1 Layout & Rhythm
- **Height**: Fixed 40px container height (`h-10`), `overflow-x: auto`, `no-scrollbar`.
- **Spacing**: Strict 6px (`space-x-1.5`) horizontal gap between filter elements.
- **Elevation & Background**: Surface backdrop blur (`backdrop-blur-md bg-surface/85 border-b border-white/5`).

### 4.2 Master Filter Trigger
- **Visuals**: Circular 32×32px button (`w-8 h-8 rounded-full`).
- **Styling**: Gradient wash (`from-primary-container to-secondary-container`) with centered slider glyph (`tune` or `sliders`).
- **No Text & No Count Badge**: Maximizes horizontal real estate for active filter chips.
- **Interaction**: Opens the full filter bottom sheet modal.

### 4.3 Integrated Gym & Location Tile
- **Structure**: `[ (Logo) Initials · (Logo) Initials ✕ ]`
- **Gym Logos**: 18×18px 1:1 circular image avatars:
  - **Psycle**: Dark `#212121` circle with white centered mark.
  - **JAB**: Heritage crimson `#6C1F20` circle with cream centered mark.
- **Location Initials**:
  - **Typography**: 10px uppercase, **light weight** (`font-light`), high-legibility tracking (+0.5px).
  - **Initials Dictionary**:
    - Psycle: `OC` (Oxford Circus), `VIC` (Victoria), `SD` (Shoreditch), `NH` (Notting Hill), `CP` (Clapham).
    - JAB: `SW1` (Victoria / St James), `EC1` (Old Street / City).
  - **Separators**: A subtle 9px dot `·` (`opacity-30`) separates gyms.
- **Dynamic Overflow Rules**:
  - **1–2 studios selected per gym**: Render initials directly (e.g. `(P) OC, NH · (J) SW1`).
  - **3+ studios selected for a gym**: Dynamically compress to count (e.g. `(P) 3 · (J) 2`) to ensure the tile never exceeds ~100px.
- **Dismiss Action**: Discrete `✕` button at trailing edge clears all gym and studio selections.

### 4.4 Active Workout / Class Type Pill
- **Single selection**: Shows glyph + short label: `[ 🚴 Ride ✕ ]` or `[ 🥊 Boxing ✕ ]`.
- **Multiple selections**: Aggregates to preserve width: `[ 🚴 Ride, Box ✕ ]` (2 types) or `[ 🚴 3 Types ✕ ]` (3+ types).
- **Terminology**: Labeled strictly as **Workout** / **Class Type**, avoiding the term "Discipline".

### 4.5 Instructor Filter Pill (Strictly Conditional)
- **Inactive State**: **Omitted entirely**. Does not occupy screen space when no instructor is filtered.
- **Active State (Single Instructor Selected)**:
  - Displays the instructor's 20×20px circular headshot image avatar.
  - Accompanied by their first name in 11px normal weight text + `✕` dismiss button: `[ (Avatar) Fae ✕ ]`.
- **Active State (2+ Instructors Selected)**: Displays `[ 👤 2 Instructors ✕ ]`.

### 4.6 Quick Bookmark Toggle
- 30×30px circular button (`[ ♡ ]`) pinned to the trailing edge of the horizontal scroll.

---

## 5. Expanded Filter Bottom Sheet Modal Specification

### 5.1 Header & Navigation
- **Header**: Sheet title ("Filters"), dynamic counter badge (`3 Active`), `Reset All` text button, and circular dismiss `✕`.
- **Category Tabs**: Horizontal pill strip (`Gyms (2)`, `Locations (3)`, `Workouts (1)`, `Instructors (1)`).

### 5.2 Brand Cards (Gym > Location Hierarchy)
- **Brand Plates**: Authentic dark plates **without colored dots**:
  - Psycle: `#212121` plate with crisp white `PSYCLE` wordmark.
  - JAB: `#6C1F20` plate with crisp white `JAB` wordmark.
- **Studio Sub-Grid**: 2-column rounded checkbox buttons under each brand card showing:
  - Checkbox indicator (ticked when active).
  - Studio name (e.g. "Oxford Circus", "SW1 (Victoria)").
  - Real-time matching class counter badge (e.g. `[8]`, `[4]`).

### 5.3 Workouts Section
- Clean multi-select pill cards for class formats (`Ride 45/60`, `Boxing & Rounds`, `Strength & Conditioning`, `Barre`).

---

## 6. Technical Implementation Details

### Files Affected
1. `client/src/ui/timetable.js`:
   - Replace legacy `<select>` dropdown flex row with the single-row dynamic filter rail renderer.
   - Implement bottom sheet modal component with Gym > Studio hierarchy.
   - Add initial-compression helper (`compressStudioName(id)`).
2. `client/src/styles.css`:
   - Add styles for `.filter-bar-rail`, `.filter-gym-tile`, `.filter-pill-compact`, and the bottom sheet drawer.
   - Enforce single-row height constraint (`max-height: 40px`).
