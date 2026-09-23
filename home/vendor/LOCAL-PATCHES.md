# Local Three.js adjustment

`addons/math/Octree.js` inherits `maxLevel` and `trianglesPerLeaf` when creating each child. The upstream constructor resets both to its defaults. Without this inheritance, setting the walkthrough root to depth 12 still allows deeper children to subdivide to their default depth 16.

The patch preserves the existing triangle geometry and collision routines. Retain it when refreshing this bundled dependency, or verify that the upstream implementation now propagates those settings.
