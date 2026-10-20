"use strict";

// Page affichée par le service worker quand le serveur est injoignable :
// on sonde régulièrement et on recharge dès qu'il répond.

const status = document.getElementById("status");
const seconds = 5; // une petite requête toutes les 5 s : le retour est détecté vite

async function probe() {
  status.textContent = "Vérification…";
  try {
    // /favicon.ico répond 204 quand l'app tourne ; « no-store » pour ne pas lire un cache
    const res = await fetch("/favicon.ico", { cache: "no-store", credentials: "same-origin" });
    if (res.ok || res.status === 204) {
      status.textContent = "Le serveur est de retour, rechargement…";
      location.reload();
      return;
    }
  } catch {}
  let left = seconds;
  status.textContent = `Toujours injoignable, nouvelle tentative dans ${left} s`;
  const tick = setInterval(() => {
    left -= 1;
    if (left > 0) status.textContent = `Toujours injoignable, nouvelle tentative dans ${left} s`;
    else {
      clearInterval(tick);
      probe();
    }
  }, 1000);
}

document.getElementById("retry").addEventListener("click", () => location.reload());
probe();
