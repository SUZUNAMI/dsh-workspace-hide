/**
 * dsh-workspace-hide -- host entry.
 *
 * This plugin is intentionally client-only: all of its behaviour (filtering the
 * sidebar workspace list, persisting the hidden set in localStorage, and the
 * "Settings -> Hidden workspaces" management page) lives in lib/client.js.
 *
 * The node still has to exist in the profile's layer stack so that the web
 * client discovers and loads the client half, which is why cordis.patch.yml
 * inserts an (empty) host node. `apply` therefore does nothing on purpose --
 * see plot3d-surface for the same minimal-bundle shape.
 *
 * `inject: []` means the host half needs no services; it must not require any,
 * or profiles that lack a service would fail to boot.
 */

export const name = 'dsh-workspace-hide';

export const inject = [];

export function apply() {
  // No host-side behaviour: the feature is a client-side overlay.
}
