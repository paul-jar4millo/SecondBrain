# Design: the blue refuge

## Direction

A night-time toon low-poly loft above a faceted sea. Full-screen world, a HUD
of slanted polygons, and tools with a blue frame and a light interior. The
scene is modeled in Blender and rendered with Three.js.

## Color and type

| Use                          | Color                |
| ---------------------------- | -------------------- |
| Night and ink                | `#0a1238`, `#0f1a55` |
| Blue and cobalt              | `#2340c8`, `#2f66e6` |
| Sky and ice                  | `#78bdf8`, `#cfe6ff` |
| Light text                   | `#f1f7ff`            |
| Selection and primary action | `#fff2c4`            |
| Occasional alerts            | `#ff6f61`            |
| Reading: background and ink  | `#eef4ff`, `#12205e` |

Dela Gothic One for titles; Fredoka for the HUD and characters; the system
font for forms and figures. Bundled fonts keep their OFL licenses in
`dashboard/public/fonts`.

## Composition

One connected map with Workshop, Library, Greenhouse, Café and Terrace. A
third-person follow camera with zoom, rotation and a Center action. Exactly
four base agents; extra sessions appear as copies.

The HUD shows brand and zone, actions, minimap, team and labeled shortcuts.
Compact mode folds the map and team. Layers never overlap the dock.

Tools use Workspace's shared dialog. Agent profiles keep the content below
them; Escape first closes the profile, then the tool. Keep labels, visible
focus, touch targets of at least 44 px and readable forms.

Team opens conversations in three columns: an ink rail with the four agents,
a panel with project, optional repository link and history, and the
provider's structured conversation. On mobile the rail moves to the top and
history folds to prioritize reading and replying. Questions and permissions
are persistent cards; tool calls are collapsible details.

Create in a list is a floating moon button at the bottom right; in views with
a side panel (such as project detail) it is a primary button in the tab row so
it never covers the panel. Multi-line free text lives in Create in the HUD.
Settings is organized as General, Team, Data, Security and About, and stores
only this device's preferences in the browser.

## Implementation and checks

Tokens and rules: `dashboard/src/styles/refuge.css` and
`dashboard/src/styles/tools.css`. Camera: `dashboard/src/features/room/room-camera.ts`.
Modeling: `dashboard/ops/room-refuge.py`.

Never invent work states or deliverables. Reduced motion, disconnection and
missing WebGL must keep access to the data.
