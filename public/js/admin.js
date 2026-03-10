document.addEventListener('click', async function(e) {
  const card = e.target.closest('.light-file-card');
  if (!card) return;
  const filename = card.dataset.filename;

  if (e.target.closest('.rename-btn')) {
    const ext = filename.substring(filename.lastIndexOf('.'));
    const base = filename.substring(0, filename.lastIndexOf('.'));
    const newName = prompt('New name (without extension, ' + ext + ' will be kept):', base);
    if (!newName || newName.trim() === base) return;
    try {
      const res = await fetch('/admin/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, newName: newName.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        card.dataset.filename = data.newName;
        card.dataset.url = data.newUrl;
        const nameEl = card.querySelector('.name');
        if (nameEl) { nameEl.textContent = data.newName; nameEl.title = data.newName; }
        const link = card.querySelector('a');
        if (link) link.href = data.newUrl;
        const img = card.querySelector('img');
        if (img) img.alt = data.newName;
      } else {
        alert(data.error || 'Rename failed');
      }
    } catch (err) {
      alert('Rename failed: ' + err.message);
    }
  }

  if (e.target.closest('.delete-btn')) {
    if (!confirm('Delete ' + filename + '?')) return;
    try {
      const res = await fetch('/admin/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });
      if (res.ok) {
        card.remove();
      } else {
        alert('Delete failed');
      }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }
});
