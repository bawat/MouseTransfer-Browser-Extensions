// options.js
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["endpoint", "token"], (r) => {
  // Empty = the default (the placeholder): the extension then tries the bridge on 24817 and, for an
  // older wrapper, 24812. Only a value typed here is a user endpoint (used as is, no fallback).
  $("endpoint").value = r.endpoint || "";
  $("token").value = r.token || "";
});

$("save").addEventListener("click", () => {
  const endpoint = $("endpoint").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  chrome.storage.local.set({ endpoint, token }, () => {
    $("status").textContent = "Saved.";
    setTimeout(() => ($("status").textContent = ""), 2000);
  });
});
