"use client";

import { useEffect, useRef, useState } from "react";
import { createDraw, type DrawController } from "@/features/drawing/draw";
import {
  GoogleDrawingMapAdapter,
  type GoogleMap,
  type GoogleDrawingMode,
  type GoogleMapsEventListener,
  type GoogleMapsNamespace,
  type GoogleRenderingType,
} from "@/features/map/google-drawing-map-adapter";

declare global {
  interface Window {
    google?: { maps?: GoogleMapsNamespace };
    __worldrawingGoogleMapsBenchmarkReady?: () => void;
  }
}

const SCRIPT_ID = "worldrawing-google-maps-benchmark";
const CALLBACK_NAME = "__worldrawingGoogleMapsBenchmarkReady";
let googleMapsPromise: Promise<GoogleMapsNamespace> | null = null;

function loadGoogleMaps(apiKey: string) {
  const loadedMaps = window.google?.maps;
  if (loadedMaps?.Map) return Promise.resolve(loadedMaps);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    window.__worldrawingGoogleMapsBenchmarkReady = () => {
      const maps = window.google?.maps;
      window.__worldrawingGoogleMapsBenchmarkReady = undefined;

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
      window.__worldrawingGoogleMapsBenchmarkReady = undefined;
      googleMapsPromise = null;
      script.remove();
      reject(new Error("Google Maps JavaScript API failed to load."));
    };
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}

export default function GoogleMapsBenchmarkPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const mapHasExisted = useRef(false);
  const [renderingType, setRenderingType] =
    useState<GoogleRenderingType>("UNINITIALIZED");
  const [completedDrawings, setCompletedDrawings] = useState(0);
  const [drawingMode, setDrawingMode] =
    useState<GoogleDrawingMode>("Navigate");
  const [mapRecreated, setMapRecreated] = useState(false);
  const [drawingReady, setDrawingReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    const container = mapContainer.current;
    if (!container) return;

    if (!apiKey) {
      setError("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY");
      return;
    }

    let cancelled = false;
    let map: GoogleMap | null = null;
    let maps: GoogleMapsNamespace | null = null;
    let adapter: GoogleDrawingMapAdapter | null = null;
    let drawing: DrawController | null = null;
    let tilesLoadedListener: GoogleMapsEventListener | null = null;

    loadGoogleMaps(apiKey)
      .then((loadedMaps) => {
        if (cancelled) return;

        maps = loadedMaps;
        if (mapHasExisted.current) setMapRecreated(true);
        mapHasExisted.current = true;
        map = new loadedMaps.Map(container, {
          center: { lat: 36.25956997955441, lng: 137.9150899566626 },
          zoom: 1,
          mapTypeId: loadedMaps.MapTypeId.ROADMAP,
          renderingType: loadedMaps.RenderingType.VECTOR,
          tilt: 0,
          heading: 0,
          tiltInteractionEnabled: false,
          headingInteractionEnabled: false,
          disableDefaultUI: true,
          keyboardShortcuts: false,
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        mapRef.current = map;

        setRenderingType(map.getRenderingType());
        tilesLoadedListener = loadedMaps.event.addListenerOnce(
          map,
          "tilesloaded",
          () => {
            if (!map || cancelled) return;
            const actualRenderingType = map.getRenderingType();
            setRenderingType(actualRenderingType);
            console.info(
              "[Google Maps benchmark] map.getRenderingType():",
              actualRenderingType,
            );
          },
        );

        adapter = new GoogleDrawingMapAdapter({
          container,
          map,
          maps: loadedMaps,
          onCompletedDrawingCountChange: setCompletedDrawings,
          onModeChange: setDrawingMode,
        });

        return adapter.whenReady().then(() => {
          if (cancelled || !adapter) return;
          drawing = createDraw({
            map: adapter.asMapLibreMap(),
            onReady: () => setDrawingReady(true),
          });
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setError(
          error instanceof Error ? error.message : "Google Maps failed to load.",
        );
      });

    return () => {
      cancelled = true;
      tilesLoadedListener?.remove();
      drawing?.stop();
      adapter?.stop();
      if (map && maps) maps.event.clearInstanceListeners(map);
      mapRef.current = null;
      container.replaceChildren();
    };
  }, [apiKey]);

  const vectorConfirmed = renderingType === "VECTOR";

  return (
    <main className="fixed inset-0 bg-[#e5e3df]">
      <div
        ref={mapContainer}
        className="h-full w-full"
        aria-label="Google Maps Worldrawing interaction benchmark"
      />
      <aside
        className={`fixed top-3 left-3 z-10 max-w-64 rounded px-3 py-2 font-mono text-xs shadow ${
          vectorConfirmed ? "bg-green-950 text-green-100" : "bg-black text-white"
        }`}
      >
        {error ? (
          <div className="text-red-300">{error}</div>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
              <dt>Rendering</dt>
              <dd>{renderingType}</dd>
              <dt>Completed</dt>
              <dd>{completedDrawings}</dd>
              <dt>Mode</dt>
              <dd>{drawingReady ? drawingMode : "Loading drawing…"}</dd>
              <dt>Map recreated</dt>
              <dd>{mapRecreated ? "true" : "false"}</dd>
            </dl>
            <p className="mt-2 border-t border-white/25 pt-2 font-sans leading-4">
              Hold Space + drag to draw or move an area. Drag an edge to deform.
              Right-click an area to delete. Escape cancels an open stroke.
            </p>
          </>
        )}
      </aside>
    </main>
  );
}
