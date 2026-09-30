import type {
  GoogleMap,
  GoogleMapsNamespace,
} from "./google-drawing-map-adapter";

declare global {
  interface Window {
    google?: { maps?: GoogleMapsNamespace };
    __worldrawingGoogleMapsReady?: () => void;
  }
}

const SCRIPT_ID = "worldrawing-google-maps";
const CALLBACK_NAME = "__worldrawingGoogleMapsReady";
const WORLD_BOUNDS = {
  north: 85.05112878,
  south: -85.05112878,
  east: 179.999999,
  west: -179.999999,
};
let googleMapsPromise: Promise<GoogleMapsNamespace> | null = null;

export function loadGoogleMaps(apiKey: string) {
  const loadedMaps = window.google?.maps;
  if (loadedMaps?.Map) return Promise.resolve(loadedMaps);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    window.__worldrawingGoogleMapsReady = () => {
      const maps = window.google?.maps;
      window.__worldrawingGoogleMapsReady = undefined;

      if (!maps?.Map) {
        googleMapsPromise = null;
        reject(new Error("Google Maps loaded without the maps library."));
        return;
      }

      resolve(maps);
    };

    const query = new URLSearchParams({
      key: apiKey,
      loading: "async",
      callback: CALLBACK_NAME,
      v: "weekly",
    });
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = `https://maps.googleapis.com/maps/api/js?${query}`;
    script.async = true;
    script.onerror = () => {
      window.__worldrawingGoogleMapsReady = undefined;
      googleMapsPromise = null;
      script.remove();
      reject(new Error("Google Maps JavaScript API failed to load."));
    };
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}

export function createGoogleWorldMap(
  container: HTMLElement,
  maps: GoogleMapsNamespace,
): GoogleMap {
  return new maps.Map(container, {
    center: { lat: 0, lng: 0 },
    zoom: 1,
    restriction: {
      latLngBounds: WORLD_BOUNDS,
      strictBounds: true,
    },
    mapTypeId: maps.MapTypeId.ROADMAP,
    renderingType: maps.RenderingType.VECTOR,
    tilt: 0,
    heading: 0,
    tiltInteractionEnabled: false,
    headingInteractionEnabled: false,
    disableDefaultUI: true,
    keyboardShortcuts: false,
    clickableIcons: false,
    gestureHandling: "greedy",
  });
}
