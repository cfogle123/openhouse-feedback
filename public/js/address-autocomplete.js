// Lightweight address autocomplete: builds a filtered, tappable suggestion
// list under a text input from a plain array of addresses.
//
// Built as a small custom widget instead of the native <input list> /
// <datalist> combo because iOS Safari does not reliably show datalist
// suggestions on phones/tablets, even though it works fine on desktop
// browsers. Shared by any page that needs to pick a house address (the
// agent feedback form, the visitor sign-in house picker, etc).
function initAddressAutocomplete(input, list, options) {
  if (!input || !list) return;
  options = options || {};
  var addresses = options.addresses || [];
  var activeIndex = -1;

  function render(matches) {
    list.innerHTML = '';
    activeIndex = -1;
    if (matches.length === 0) {
      list.hidden = true;
      return;
    }
    matches.forEach(function (address) {
      var li = document.createElement('li');
      li.className = 'suggestion-item';
      li.textContent = address;
      li.setAttribute('role', 'option');
      li.addEventListener('mousedown', function (e) {
        // mousedown (not click) fires before the input's blur event, so
        // the selection registers even though the list is about to hide.
        e.preventDefault();
        input.value = address;
        list.hidden = true;
        if (typeof options.onSelect === 'function') options.onSelect(address);
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function matchesFor(query) {
    var q = query.trim().toLowerCase();
    var pool = addresses;
    if (q) pool = pool.filter(function (a) { return a.toLowerCase().indexOf(q) !== -1; });
    return pool.slice(0, 8);
  }

  input.addEventListener('focus', function () {
    render(matchesFor(input.value));
  });
  input.addEventListener('input', function () {
    render(matchesFor(input.value));
  });
  input.addEventListener('blur', function () {
    setTimeout(function () { list.hidden = true; }, 100);
  });
  input.addEventListener('keydown', function (e) {
    var items = list.querySelectorAll('.suggestion-item');
    if (list.hidden || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      input.value = items[activeIndex].textContent;
      list.hidden = true;
      if (typeof options.onSelect === 'function') options.onSelect(items[activeIndex].textContent);
      return;
    } else if (e.key === 'Escape') {
      list.hidden = true;
      return;
    } else {
      return;
    }
    items.forEach(function (el, i) { el.classList.toggle('active', i === activeIndex); });
  });
}
