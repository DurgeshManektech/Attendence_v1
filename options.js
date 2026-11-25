const KEY = 'mtworks_member_id_override';
const input = document.getElementById('memberId');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const savedMsg = document.getElementById('savedMsg');

chrome.storage.local.get(KEY).then((res) => {
  if (res[KEY]) input.value = res[KEY];
});

saveBtn.addEventListener('click', async () => {
  const val = input.value.trim();
  if (!val) return;
  await chrome.storage.local.set({ [KEY]: val });
  savedMsg.textContent = 'Saved ✓ — now showing this Member ID instead of your own.';
  savedMsg.style.display = 'inline';
  setTimeout(() => (savedMsg.style.display = 'none'), 2500);
});

if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(KEY);
    input.value = '';
    savedMsg.textContent = 'Cleared — back to auto-detecting your own login.';
    savedMsg.style.display = 'inline';
    setTimeout(() => (savedMsg.style.display = 'none'), 2500);
  });
}
