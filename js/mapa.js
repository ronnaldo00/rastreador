// La página que muestra dónde está el celular.
// Lo que hace, en resumen:
//   1. Averigua la URL de Firebase y la clave (de config.js o de lo guardado).
//   2. Cada 15 segundos LEE la última ubicación del "buzón" (un GET).
//   3. Mueve el punto en el mapa y actualiza los datos (hace cuánto, batería…).
//
// La página NUNCA habla con el celular directamente: las dos hablan con Firebase.

// ---------- 1. Configuración (URL + clave) ----------
// Primero lo que esté guardado en este navegador; si no, lo de config.js.
function leerConfig() {
  let guardado = {};
  try { guardado = JSON.parse(localStorage.getItem("rastreador") || "{}"); } catch (e) {}
  const base = window.CONFIG || {};
  return {
    urlBase: (guardado.urlBase || base.urlBase || "").replace(/\/+$/, ""),
    clave: guardado.clave || base.clave || ""
  };
}

function guardarConfig(urlBase, clave) {
  localStorage.setItem("rastreador", JSON.stringify({ urlBase, clave }));
}

let config = leerConfig();

// ---------- 2. El mapa ----------
// Arranca mirando a Tunja hasta que llegue el primer dato.
const mapa = L.map("mapa").setView([5.535, -73.367], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(mapa);

// Leaflet busca sus iconos en una carpeta; se la decimos a mano.
L.Icon.Default.prototype.options.imagePath = "vendor/images/";

let marcador = null;      // el "pin" en el mapa
let circulo = null;       // el círculo de precisión alrededor del pin
let yaCentre = false;     // para centrar el mapa solo la primera vez
let ultimoDato = null;    // el último reporte recibido
let recorrido = null;     // la línea del recorrido (historial)

// ---------- 3. Leer el buzón ----------
// Construye la dirección: urlBase + "/celulares/" + clave + "/ultima.json"
function direccion(sufijo) {
  return `${config.urlBase}/celulares/${encodeURIComponent(config.clave)}/${sufijo}.json`;
}

async function pedirUbicacion() {
  // Sin configuración no hay nada que pedir: mostramos los ajustes.
  if (!config.urlBase || config.clave.length < 20) {
    ponerEstado("gris", "Falta configurar (toca ⚙️ Ajustes)");
    abrirConfig();
    return;
  }
  try {
    const resp = await fetch(direccion("ultima"), { cache: "no-store" });
    if (!resp.ok) throw new Error("respuesta " + resp.status);
    const dato = await resp.json();
    if (!dato || typeof dato.lat !== "number") {
      ponerEstado("gris", "Aún no hay reportes de este celular");
      return;
    }
    ultimoDato = dato;
    pintar(dato);
    pintarRecorrido();
  } catch (e) {
    ponerEstado("viejo", "Sin conexión con Firebase");
    console.error(e);
  }
}

// Lee el historial y dibuja la línea del recorrido (los últimos 50 puntos).
async function pintarRecorrido() {
  try {
    // orderBy="$key"&limitToLast=50 → los 50 reportes más recientes.
    const resp = await fetch(direccion("historial") + '?orderBy="$key"&limitToLast=50', { cache: "no-store" });
    if (!resp.ok) return;
    const hist = await resp.json();
    if (!hist) return;
    // Ordenar por la hora (la llave) y sacar la lista de coordenadas.
    const puntos = Object.keys(hist).sort()
      .map((k) => hist[k])
      .filter((d) => d && typeof d.lat === "number")
      .map((d) => [d.lat, d.lng]);
    if (puntos.length < 2) return;
    if (!recorrido) {
      recorrido = L.polyline(puntos, { color: "#4f7cff", weight: 4, opacity: .6 }).addTo(mapa);
    } else {
      recorrido.setLatLngs(puntos);
    }
  } catch (e) { /* si falla el historial, no pasa nada: el pin sigue */ }
}

// ---------- 4. Pintar en pantalla ----------
function pintar(dato) {
  const punto = [dato.lat, dato.lng];

  // El pin
  if (!marcador) {
    marcador = L.marker(punto).addTo(mapa);
  } else {
    marcador.setLatLng(punto);
  }

  // El círculo de precisión (qué tan seguro está el GPS, en metros)
  if (dato.precision) {
    if (!circulo) {
      circulo = L.circle(punto, { radius: dato.precision, color: "#4f7cff", opacity: .4, fillOpacity: .1 }).addTo(mapa);
    } else {
      circulo.setLatLng(punto).setRadius(dato.precision);
    }
  }

  // Centrar el mapa solo la primera vez (para no estorbar si estás mirando otra zona)
  if (!yaCentre) { mapa.setView(punto, 16); yaCentre = true; }

  // Globo con la hora al tocar el pin
  marcador.bindPopup(`Visto ${haceCuanto(dato.hora)}<br>${new Date(dato.hora).toLocaleString()}`);

  actualizarDatos(dato);
}

// Rellena la fila de tarjetas de arriba.
function actualizarDatos(dato) {
  document.getElementById("d-hace").textContent = haceCuanto(dato.hora);
  document.getElementById("d-bateria").textContent =
    (dato.bateria != null ? dato.bateria + " %" : "—") + (dato.cargando ? " ⚡" : "");
  document.getElementById("d-precision").textContent =
    dato.precision != null ? Math.round(dato.precision) + " m" : "—";
  document.getElementById("d-velocidad").textContent =
    dato.velocidad != null ? Math.round(dato.velocidad * 3.6) + " km/h" : "—";

  // Verde si reportó hace menos de 5 min; rojo si hace rato.
  const minutos = (Date.now() - dato.hora) / 60000;
  if (minutos < 5) ponerEstado("vivo", "En línea · " + haceCuanto(dato.hora));
  else ponerEstado("viejo", "Última vez " + haceCuanto(dato.hora));
}

// ---------- 5. Ayudantes ----------
// Convierte una hora (en milisegundos) en "hace 2 min", "hace 1 h"…
function haceCuanto(hora) {
  const seg = Math.max(0, Math.floor((Date.now() - hora) / 1000));
  if (seg < 60) return "hace " + seg + " s";
  const min = Math.floor(seg / 60);
  if (min < 60) return "hace " + min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return "hace " + h + " h";
  return "hace " + Math.floor(h / 24) + " días";
}

function ponerEstado(clase, texto) {
  const punto = document.getElementById("punto-estado");
  punto.className = "";
  if (clase === "vivo") punto.classList.add("vivo");
  if (clase === "viejo") punto.classList.add("viejo");
  document.getElementById("estado-texto").textContent = texto;
}

// ---------- 6. Ventana de ajustes ----------
const caja = document.getElementById("config-caja");
function abrirConfig() {
  document.getElementById("in-url").value = config.urlBase;
  document.getElementById("in-clave").value = config.clave;
  caja.classList.add("visible");
}
function cerrarConfig() { caja.classList.remove("visible"); }

document.getElementById("btn-config").onclick = abrirConfig;
document.getElementById("btn-cancelar").onclick = cerrarConfig;
document.getElementById("btn-guardar").onclick = () => {
  const url = document.getElementById("in-url").value.trim().replace(/\/+$/, "");
  const clave = document.getElementById("in-clave").value.trim();
  if (clave.length < 20) { alert("La clave debe tener 20 letras o más."); return; }
  guardarConfig(url, clave);
  config = leerConfig();
  yaCentre = false;
  cerrarConfig();
  pedirUbicacion();
};

// ---------- 7. Arranque: pedir ya y luego cada 15 segundos ----------
pedirUbicacion();
setInterval(pedirUbicacion, 15000);
// Refresca el "hace X min" cada segundo aunque no llegue dato nuevo.
setInterval(() => { if (ultimoDato) actualizarDatos(ultimoDato); }, 1000);
