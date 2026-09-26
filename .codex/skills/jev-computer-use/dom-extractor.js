/**
 * Ultra-fast interactive DOM extractor for TypeSafe Jev computer-use agents.
 * Injected into the browser page via Playwright / Puppeteer / CDP.
 * Extracts only visible, interactive elements and formats an indexed action table.
 */
(() => {
  const INTERACTIVE_SELECTORS = [
    'button',
    'input',
    'textarea',
    'select',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ];

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // Check if element is within the viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
    return true;
  }

  function getCleanLabel(el) {
    // Priority: aria-label -> placeholder -> textContent -> title -> alt -> name
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button') && el.value) return el.value.trim();
    const text = el.innerText || el.textContent || '';
    if (text.trim()) return text.trim().slice(0, 60).replace(/\s+/g, ' ');
    if (el.title) return el.title.trim();
    if (el.name) return el.name.trim();
    const img = el.querySelector('img');
    if (img && img.alt) return img.alt.trim();
    return '';
  }

  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS.join(',')));
  const visibleElements = [];
  const actionTable = [];
  const lookup = {};

  let index = 1;
  for (const el of elements) {
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const type = el.getAttribute('type') || '';
    const label = getCleanLabel(el);
    const value = el.value || '';
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';

    // Format clean descriptor line
    let desc = `[${index}] <${tag}`;
    if (type) desc += ` type="${type}"`;
    if (role !== tag) desc += ` role="${role}"`;
    if (label) desc += ` label="${label}"`;
    if (value && value !== label) desc += ` value="${value.slice(0, 30)}"`;
    if (disabled) desc += ' disabled';
    desc += '>';

    actionTable.push(desc);
    lookup[index] = {
      index,
      tag,
      type,
      role,
      label,
      value,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      selector: el.id ? `#${el.id}` : null
    };

    index++;
  }

  return {
    url: window.location.href,
    title: document.title,
    scrollY: window.scrollY,
    maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
    table: actionTable.join('\n'),
    elementCount: actionTable.length,
    elements: lookup
  };
})();
