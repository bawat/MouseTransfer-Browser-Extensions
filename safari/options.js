// options.js
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["endpoint", "token"], (r) => {
  $("endpoint").value = r.endpoint || "http://127.0.0.1:24812";
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
