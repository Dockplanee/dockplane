/**
 * What a screen has to hold at a given width, and how to ask a browser.
 *
 * The functional suites run at one desktop size, because what they check is
 * behaviour and behaviour does not change with the window. What does change is
 * whether an operator can reach it: 0.2.0 lays every list out as one desktop
 * table and lets the viewport scroll sideways, so on a narrow window a
 * container's state, health and actions are off-screen while the page itself
 * reports no overflow at all. A test that only asks "does the page overflow"
 * would pass on exactly that.
 *
 * So these assertions ask where things are, not how they look. Nothing here
 * compares screenshots: a pixel diff fails for a font and passes for a row
 * whose action menu sits 400 pixels to the right of the window.
 */

/**
 * The five widths the product is designed against.
 *
 * Named rather than numbered, because a finding is about a class of window —
 * a phone, a laptop — and the exact pixel is an implementation detail of the
 * measurement.
 */
export const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'small tablet', width: 600, height: 960 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
];

/** Widths used to find the edge of a behaviour rather than to check one. */
export const BOUNDARIES = [1280, 1500];

/**
 * Everything one page reveals about how it fits, read in the page itself.
 *
 * Collected in a single evaluation so the numbers describe one layout rather
 * than several taken as the page settled.
 */
export const MEASURE = `(() => {
  const root = document.documentElement;
  const view = { width: root.clientWidth, height: root.clientHeight };

  const table = document.querySelector('table');
  const scroller = table ? table.closest('[style*="overflow"], .dp-table-wrap, div') : null;

  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
  };

  // An element counts as reachable when a person can act on it without moving
  // the window sideways: inside the viewport, and not behind something else.
  //
  // A control inside a dialog that is not open is not on the page at all. It
  // measures 0 by 0 and would otherwise read as an action that has been cut
  // off — every detail screen carries a confirmation dialog, and its Confirm
  // button is the first primary button in the document.
  const reachable = (element) => {
    if (!element) return null;
    const closedDialog = element.closest('dialog');
    if (closedDialog && !closedDialog.open) return null;
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    if (box.right > view.width + 1 || box.left < -1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const first = (selector) =>
    [...document.querySelectorAll(selector)].find((element) => {
      const dialog = element.closest('dialog');
      return !dialog || dialog.open;
    }) ?? null;

  // Whether any element matching the selector can be acted on.
  //
  // Not the first one: a control that exists in both layouts appears twice in
  // the document, and the copy for the other layout is laid out at zero size.
  // The navigation is exactly that — the sidebar's collapse control comes first
  // in the document and is absent on a narrow window, where the top bar's
  // control is the way in.
  const anyReachable = (selector) =>
    [...document.querySelectorAll(selector)].some((element) => reachable(element) === true);

  return {
    path: location.pathname,
    view,
    pageOverflow: root.scrollWidth - root.clientWidth,
    table: table
      ? {
          width: Math.round(table.scrollWidth),
          fits: scroller ? Math.round(scroller.clientWidth) : null,
          overflowX: scroller ? getComputedStyle(scroller).overflowX : null,
          columns: [...table.querySelectorAll('thead th')].map((th) => ({
            label: th.textContent.trim().slice(0, 24),
            ...rect(th),
            inView: rect(th).right <= view.width + 1,
          })),
        }
      : null,
    // Narrow layouts hold the navigation off-canvas behind a control, which is
    // the intended behaviour rather than a fault: what matters is that a person
    // can get to it, by either route.
    navigation:
      anyReachable('nav') || anyReachable('[aria-label*="avigation" i], [aria-label*="menu" i]'),
    search: reachable(first('input[type=search], .dp-controls input')),
    primaryAction: reachable(first('main a.dp-button--primary, main button.dp-button--primary')),
    rowAction: reachable(first('tbody button, tbody a.dp-button, tbody [aria-haspopup]')),
    status: reachable(first('tbody .badge, tbody [class*="status"], tbody [class*="badge"]')),
    dialog: (() => {
      const open = document.querySelector('dialog[open]');
      if (!open) return null;
      const box = open.getBoundingClientRect();
      return {
        withinViewport: box.right <= view.width + 1 && box.left >= -1,
        width: Math.round(box.width),
      };
    })(),
    // The smallest interactive target on the page, which is what decides
    // whether a narrow layout is usable with a thumb.
    //
    // The target is what a person can hit, not what is drawn. A radio inside a
    // label is thirteen pixels of control inside a thirty-four pixel target,
    // and reporting the thirteen would ask for a fix to something that is not
    // a fault.
    smallestControl: (() => {
      const target = (element) => {
        const label = element.closest('label');
        const box = (label ?? element).getBoundingClientRect();
        return { height: box.height, width: box.width };
      };

      const targets = [...document.querySelectorAll('main button, main a.dp-button, main select, main input')]
        .map(target)
        .filter((box) => box.width > 0 && box.height > 0);

      if (targets.length === 0) return null;
      return Math.round(Math.min(...targets.map((box) => box.height)));
    })(),
  };
})()`;

/**
 * The columns an operator needs before the list is worth showing at all.
 *
 * A list that shows what a thing is called but not what it is doing, or offers
 * no way to act on it, has lost the reason somebody opened it. Which columns
 * those are differs per screen, so the caller names them.
 */
export function operationalColumnsInView(measurement, required) {
  if (!measurement.table) return { applicable: false };

  const labels = measurement.table.columns.map((column) => column.label.toLowerCase());
  const missing = [];
  const outside = [];

  for (const name of required) {
    const index = labels.findIndex((label) => label.includes(name.toLowerCase()));
    if (index === -1) {
      missing.push(name);
      continue;
    }
    if (!measurement.table.columns[index].inView) outside.push(name);
  }

  return { applicable: true, missing, outside, satisfied: missing.length === 0 && outside.length === 0 };
}

/** Whether the table needs the window moved sideways to be read. */
export function tableNeedsSidewaysScroll(measurement) {
  if (!measurement.table || measurement.table.fits === null) return false;
  return measurement.table.width > measurement.table.fits + 1;
}
