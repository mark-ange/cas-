import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// ADDED: Shared coordinate type used by the publisher and the advisory map.
export type CommunityAlertMapLocation = {
  latitude: number;
  longitude: number;
};

// ADDED: The fields needed to display a saved advisory pin and its details.
export type CommunityAlertMapAnnouncement = CommunityAlertMapLocation & {
  id: number;
  title: string;
  utility: string;
  area: string;
  status: string;
};

type MapsListener = { remove: () => void };
type MapsMapEvent = {
  latLng?: { lat: () => number; lng: () => number } | null;
};

type MapsLatLng = { lat: () => number; lng: () => number };

interface MapsMapInstance {
  addListener(eventName: string, handler: (event: MapsMapEvent) => void): MapsListener;
  setCenter(position: { lat: number; lng: number }): void;
  setZoom(zoom: number): void;
  fitBounds(bounds: MapsLatLngBounds): void;
}

interface MapsMarker {
  setMap(map: MapsMapInstance | null): void;
  addListener(eventName: string, handler: () => void): MapsListener;
}

interface MapsGeocoder {
  geocode(
    request: { address: string },
    callback: (results: Array<{ geometry: { location: MapsLatLng } }> | null, status: string) => void,
  ): void;
}

interface MapsInfoWindow {
  setContent(content: HTMLElement | string): void;
  open(options: { map: MapsMapInstance; anchor?: MapsMarker }): void;
}

interface MapsLatLngBounds {
  extend(position: { lat: number; lng: number }): void;
}

interface GoogleMapsApi {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => MapsMapInstance;
  Marker: new (options: { map: MapsMapInstance; position: { lat: number; lng: number }; title?: string }) => MapsMarker;
  Geocoder: new () => MapsGeocoder;
  InfoWindow: new (options?: { content?: HTMLElement | string }) => MapsInfoWindow;
  LatLngBounds: new () => MapsLatLngBounds;
}

declare global {
  interface Window {
    google?: { maps?: GoogleMapsApi };
    gm_authFailure?: () => void;
  }
}

const DEFAULT_CAGAYAN_DE_ORO: CommunityAlertMapLocation = {
  // ADDED: Default viewport centered on the likely CEPALCO service region.
  latitude: 8.4542,
  longitude: 124.6319,
};

let mapsScriptPromise: Promise<GoogleMapsApi> | null = null;
const MAP_AUTH_FAILURE_EVENT = "civicalert-google-maps-auth-failure";

// ADDED: Load the Maps JavaScript API once per page, using each Vite app's local env key.
function loadGoogleMaps(apiKey: string): Promise<GoogleMapsApi> {
  window.gm_authFailure = () => window.dispatchEvent(new Event(MAP_AUTH_FAILURE_EVENT));
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsScriptPromise) return mapsScriptPromise;

  const pending = new Promise<GoogleMapsApi>((resolve, reject) => {
    const existing = document.getElementById("civicalert-google-maps-script") as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("Google Maps loaded without exposing the Maps JavaScript API."));
    };
    const onError = () => reject(new Error("Google Maps could not be loaded. Check the API key, billing, and website restrictions."));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      script.id = "civicalert-google-maps-script";
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
      document.head.appendChild(script);
    } else if (window.google?.maps) {
      resolve(window.google.maps);
    }
  }).catch((error: unknown) => {
    // Permit a retry after a key/billing/referrer fix, rather than caching a failed promise forever.
    document.getElementById("civicalert-google-maps-script")?.remove();
    mapsScriptPromise = null;
    throw error;
  });
  mapsScriptPromise = pending;
  return pending;
}

export function GoogleMap({
  mode,
  announcements = [],
  selectedArea,
  selectedLocation,
  onLocationSelected,
  height = 340,
  label,
}: {
  mode: "picker" | "display";
  announcements?: CommunityAlertMapAnnouncement[];
  selectedArea?: string;
  selectedLocation?: CommunityAlertMapLocation | null;
  onLocationSelected?: (location: CommunityAlertMapLocation | null) => void;
  height?: number;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onLocationSelectedRef = useRef(onLocationSelected);
  const pickerMapRef = useRef<MapsMapInstance | null>(null);
  const pickerMapsRef = useRef<GoogleMapsApi | null>(null);
  const selectionMarkerRef = useRef<MapsMarker | null>(null);
  const geocodeRequestRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [mapError, setMapError] = useState("");
  const [pickerReady, setPickerReady] = useState(false);
  const [areaLookup, setAreaLookup] = useState<"idle" | "loading" | "failed">("idle");
  const [fallbackLocation, setFallbackLocation] = useState<CommunityAlertMapLocation | null>(null);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  useEffect(() => {
    onLocationSelectedRef.current = onLocationSelected;
  }, [onLocationSelected]);

  // Keep display-mode markers in sync without rebuilding the map on every React render.
  const markerSignature = useMemo(
    () => announcements.map(item => `${item.id}|${item.latitude}|${item.longitude}|${item.title}|${item.area}|${item.status}`).join(";"),
    [announcements],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let clickListener: MapsListener | null = null;
    const plottedMarkers: MapsMarker[] = [];
    setLoading(true);
    setMapError("");
    const handleAuthFailure = () => {
      if (disposed) return;
      setLoading(false);
      setMapError(`Google Maps rejected this site's URL. In Google Cloud, add ${window.location.origin}/* to the browser key's website restrictions and allow the Maps JavaScript API.`);
    };
    window.addEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);

    if (!apiKey?.trim()) {
      setLoading(false);
      setMapError("Google Maps key is missing. Set VITE_GOOGLE_MAPS_API_KEY in this portal's .env.local file and restart Vite.");
      return () => {
        disposed = true;
        window.removeEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);
      };
    }

    void loadGoogleMaps(apiKey.trim()).then(maps => {
      if (disposed || !containerRef.current) return;

      const map = new maps.Map(container, {
        center: { lat: DEFAULT_CAGAYAN_DE_ORO.latitude, lng: DEFAULT_CAGAYAN_DE_ORO.longitude },
        zoom: mode === "picker" ? 12 : 11,
        mapTypeControl: false,
        streetViewControl: false,
        clickableIcons: false,
        fullscreenControl: true,
        gestureHandling: "greedy",
      });

      if (mode === "picker") {
        pickerMapRef.current = map;
        pickerMapsRef.current = maps;
        setPickerReady(true);
        // ADDED: Clicking a point places/moves the location pin and returns coordinates to the form.
        clickListener = map.addListener("click", event => {
          if (!event.latLng) return;
          geocodeRequestRef.current += 1;
          setAreaLookup("idle");
          const location = {
            latitude: event.latLng.lat(),
            longitude: event.latLng.lng(),
          };
          selectionMarkerRef.current?.setMap(null);
          selectionMarkerRef.current = new maps.Marker({
            map,
            position: { lat: location.latitude, lng: location.longitude },
            title: "Selected affected location",
          });
          onLocationSelectedRef.current?.(location);
        });
      } else {
        // ADDED: Display markers only for announcements that have valid saved coordinates.
        const validAnnouncements = announcements.filter(item =>
          Number.isFinite(item.latitude) && Number.isFinite(item.longitude) &&
          item.latitude >= -90 && item.latitude <= 90 &&
          item.longitude >= -180 && item.longitude <= 180,
        );
        const bounds = new maps.LatLngBounds();
        const infoWindow = new maps.InfoWindow();

        for (const announcement of validAnnouncements) {
          const position = { lat: announcement.latitude, lng: announcement.longitude };
          const marker = new maps.Marker({ map, position, title: announcement.title });
          plottedMarkers.push(marker);
          bounds.extend(position);
          marker.addListener("click", () => {
            // Use textContent rather than HTML strings to avoid treating advisory text as markup.
            const content = document.createElement("div");
            content.className = "civicalert-map-info";
            const title = document.createElement("strong");
            title.textContent = announcement.title;
            const area = document.createElement("p");
            area.textContent = `${announcement.utility} · ${announcement.area}`;
            const status = document.createElement("small");
            status.textContent = `Status: ${announcement.status}`;
            content.append(title, area, status);
            infoWindow.setContent(content);
            infoWindow.open({ map, anchor: marker });
          });
        }

        if (validAnnouncements.length === 1) {
          map.setCenter({ lat: validAnnouncements[0].latitude, lng: validAnnouncements[0].longitude });
          map.setZoom(14);
        } else if (validAnnouncements.length > 1) {
          map.fitBounds(bounds);
        }
      }

      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoading(false);
      setMapError("Google Maps could not load. Check that Maps JavaScript API is enabled, billing is active, and this localhost URL is in the key's website restrictions.");
    });

    return () => {
      disposed = true;
      window.removeEventListener(MAP_AUTH_FAILURE_EVENT, handleAuthFailure);
      clickListener?.remove();
      selectionMarkerRef.current?.setMap(null);
      selectionMarkerRef.current = null;
      pickerMapRef.current = null;
      pickerMapsRef.current = null;
      setPickerReady(false);
      for (const marker of plottedMarkers) marker.setMap(null);
    };
  // The marker signature intentionally describes marker data rather than the array identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, mode, markerSignature]);

  useEffect(() => {
    if (mode !== "picker" || !pickerReady || !selectedArea?.trim()) {
      selectionMarkerRef.current?.setMap(null);
      selectionMarkerRef.current = null;
      setAreaLookup("idle");
      return;
    }

    const map = pickerMapRef.current;
    const maps = pickerMapsRef.current;
    if (!map || !maps) return;

    const requestId = ++geocodeRequestRef.current;
    selectionMarkerRef.current?.setMap(null);
    selectionMarkerRef.current = null;
    setAreaLookup("loading");
    new maps.Geocoder().geocode(
      { address: `${selectedArea}, Cagayan de Oro City, Philippines` },
      (results, status) => {
        if (geocodeRequestRef.current !== requestId) return;
        const location = status === "OK" ? results?.[0]?.geometry.location : undefined;
        if (!location) {
          selectionMarkerRef.current?.setMap(null);
          selectionMarkerRef.current = null;
          onLocationSelectedRef.current?.(null);
          setAreaLookup("failed");
          return;
        }

        const selectedLocation = { latitude: location.lat(), longitude: location.lng() };
        map.setCenter({ lat: selectedLocation.latitude, lng: selectedLocation.longitude });
        map.setZoom(selectedArea.toLowerCase().includes("purok") ? 17 : 15);
        selectionMarkerRef.current?.setMap(null);
        selectionMarkerRef.current = new maps.Marker({
          map,
          position: { lat: selectedLocation.latitude, lng: selectedLocation.longitude },
          title: selectedArea,
        });
        onLocationSelectedRef.current?.(selectedLocation);
        setAreaLookup("idle");
      },
    );

    return () => {
      if (geocodeRequestRef.current === requestId) geocodeRequestRef.current += 1;
    };
  }, [mode, pickerReady, selectedArea]);

  const validAnnouncementCount = announcements.filter(item =>
    Number.isFinite(item.latitude) && Number.isFinite(item.longitude) &&
    item.latitude >= -90 && item.latitude <= 90 &&
    item.longitude >= -180 && item.longitude <= 180,
  ).length;

  return <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100" style={{ minHeight: height }}>
    <div ref={containerRef} style={{ height, width: "100%" }} aria-label={mode === "picker" ? "Click the map to select an affected location" : "Map of utility advisories"} />
    {mapError && <FallbackTileMap
      mode={mode}
      announcements={announcements}
      selectedLocation={selectedLocation ?? fallbackLocation}
      onLocationSelected={location => {
        setFallbackLocation(location);
        onLocationSelectedRef.current?.(location);
      }}
      height={height}
      label={label}
      mapError={mapError}
    />}
    {label && !mapError && <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-white/95 px-3 py-2 text-xs font-bold text-slate-800 shadow">{label}</div>}
    {loading && !mapError && <div role="status" className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">Loading Google Maps…</div>}
    {mapError && <div className="sr-only" role="status">{mapError}</div>}
    {mode === "picker" && !loading && !mapError && areaLookup === "loading" && <div role="status" className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">Finding the selected area and placing its map pin…</div>}
    {mode === "picker" && !loading && !mapError && areaLookup === "failed" && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 shadow">Could not locate that area on the map. Check that the Maps Geocoding service is enabled, or click the map to place the pin manually.</div>}
    {mode === "display" && !loading && !mapError && validAnnouncementCount === 0 && <div className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">No announcements have saved map coordinates yet. Select a point when publishing a new advisory to add its marker.</div>}
  </div>;
}

type MapPixel = { x: number; y: number };
type FallbackTile = MapPixel & { key: string; url: string };

function projectLocation(location: CommunityAlertMapLocation, zoom: number): MapPixel {
  const scale = 256 * 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, location.latitude));
  const sin = Math.sin(latitude * Math.PI / 180);
  return {
    x: (location.longitude + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function unprojectLocation(point: MapPixel, zoom: number): CommunityAlertMapLocation {
  const scale = 256 * 2 ** zoom;
  const longitude = point.x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * point.y / scale;
  return { latitude: 180 / Math.PI * Math.atan(Math.sinh(n)), longitude };
}

function FallbackTileMap({
  mode,
  announcements,
  selectedLocation,
  onLocationSelected,
  height,
  label,
  mapError,
}: {
  mode: "picker" | "display";
  announcements: CommunityAlertMapAnnouncement[];
  selectedLocation: CommunityAlertMapLocation | null;
  onLocationSelected: (location: CommunityAlertMapLocation) => void;
  height: number;
  label?: string;
  mapError: string;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; center: CommunityAlertMapLocation; moved: boolean } | null>(null);
  const [center, setCenter] = useState<CommunityAlertMapLocation>(() => {
    if (selectedLocation) return selectedLocation;
    const first = announcements.find(isValidLocation);
    return first ? { latitude: first.latitude, longitude: first.longitude } : DEFAULT_CAGAYAN_DE_ORO;
  });
  const [zoom, setZoom] = useState(mode === "picker" ? 12 : 11);
  const [width, setWidth] = useState(640);
  const [activeAnnouncement, setActiveAnnouncement] = useState<number | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const observer = new ResizeObserver(() => setWidth(map.clientWidth));
    observer.observe(map);
    setWidth(map.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "display") {
      const first = announcements.find(isValidLocation);
      if (first) setCenter({ latitude: first.latitude, longitude: first.longitude });
    } else if (selectedLocation) {
      setCenter(selectedLocation);
    }
  // Recenter only when the marker data or selected coordinate changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, announcements.map(item => `${item.id}:${item.latitude}:${item.longitude}`).join("|"), selectedLocation?.latitude, selectedLocation?.longitude]);

  const centerPixel = projectLocation(center, zoom);
  const origin = { x: centerPixel.x - width / 2, y: centerPixel.y - height / 2 };
  const tiles = useMemo(() => {
    const firstX = Math.floor(origin.x / 256);
    const lastX = Math.floor((origin.x + width) / 256);
    const firstY = Math.floor(origin.y / 256);
    const lastY = Math.floor((origin.y + height) / 256);
    const tileCount = 2 ** zoom;
    const result: FallbackTile[] = [];
    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      if (tileY < 0 || tileY >= tileCount) continue;
      for (let tileX = firstX; tileX <= lastX; tileX += 1) {
        const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        result.push({
          key: `${zoom}/${tileX}/${tileY}`,
          x: tileX * 256 - origin.x,
          y: tileY * 256 - origin.y,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        });
      }
    }
    return result;
  }, [height, origin.x, origin.y, width, zoom]);

  const markerPosition = (location: CommunityAlertMapLocation): MapPixel => {
    const point = projectLocation(location, zoom);
    return { x: point.x - origin.x, y: point.y - origin.y };
  };

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      center,
      moved: false,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaX = event.clientX - drag.pointerX;
    const deltaY = event.clientY - drag.pointerY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const start = projectLocation(drag.center, zoom);
    setCenter(unprojectLocation({ x: start.x - deltaX, y: start.y - deltaY }, zoom));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.moved || mode !== "picker") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: origin.x + event.clientX - bounds.left, y: origin.y + event.clientY - bounds.top };
    const location = unprojectLocation(point, zoom);
    setCenter(location);
    onLocationSelected(location);
  }

  function adjustZoom(amount: number) {
    setZoom(current => Math.max(3, Math.min(19, current + amount)));
  }

  const validAnnouncements = announcements.filter(isValidLocation);
  const pin = selectedLocation ? markerPosition(selectedLocation) : null;

  return <div
    ref={mapRef}
    role={mode === "picker" ? "application" : undefined}
    aria-label={mode === "picker" ? "OpenStreetMap location picker" : "OpenStreetMap advisory map"}
    className="absolute inset-0 overflow-hidden bg-[#e5e7eb]"
    style={{ height, touchAction: "none", cursor: mode === "picker" ? "crosshair" : "grab" }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={() => { dragRef.current = null; }}
    onWheel={event => {
      event.preventDefault();
      adjustZoom(event.deltaY < 0 ? 1 : -1);
    }}
  >
    {tiles.map(tile => <img
      key={tile.key}
      src={tile.url}
      alt=""
      draggable={false}
      className="pointer-events-none absolute h-64 w-64 max-w-none select-none"
      style={{ left: tile.x, top: tile.y }}
    />)}
    {mode === "display" && validAnnouncements.map(item => {
      const position = markerPosition(item);
      return <button
        key={item.id}
        type="button"
        title={`${item.title} — ${item.area}`}
        aria-label={`${item.title}, ${item.utility}, ${item.area}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => setActiveAnnouncement(activeAnnouncement === item.id ? null : item.id)}
        className="absolute z-[2] grid h-8 w-8 -translate-x-1/2 -translate-y-full place-items-center rounded-full border-2 border-white bg-rose-700 text-sm font-bold text-white shadow-lg"
        style={{ left: position.x, top: position.y }}
      >•</button>;
    })}
    {mode === "picker" && pin && <span
      aria-label="Selected location"
      className="pointer-events-none absolute z-[2] grid h-8 w-8 -translate-x-1/2 -translate-y-full place-items-center rounded-full border-2 border-white bg-emerald-700 text-sm font-bold text-white shadow-lg"
      style={{ left: pin.x, top: pin.y }}
    >•</span>}
    {mode === "display" && validAnnouncements.length === 0 && <div className="absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2 rounded-md bg-white/95 px-3 py-2 text-xs text-slate-700 shadow">No announcements have saved coordinates.</div>}
    {activeAnnouncement !== null && (() => {
      const announcement = validAnnouncements.find(item => item.id === activeAnnouncement);
      if (!announcement) return null;
      const position = markerPosition(announcement);
      return <div className="pointer-events-none absolute z-[3] max-w-56 -translate-x-1/2 -translate-y-[calc(100%+2.25rem)] rounded-md bg-white px-3 py-2 text-xs text-slate-800 shadow-lg" style={{ left: position.x, top: position.y }}>
        <strong className="block">{announcement.title}</strong>
        <span>{announcement.utility} · {announcement.area}</span>
        <small className="block">Status: {announcement.status}</small>
      </div>;
    })()}
    {label && <div className="pointer-events-none absolute left-3 top-3 z-[4] rounded-md bg-white/95 px-3 py-2 text-xs font-bold text-slate-800 shadow">{label}</div>}
    <div className="absolute right-3 top-3 z-[4] grid overflow-hidden rounded-md border border-slate-300 bg-white shadow">
      <button type="button" aria-label="Zoom in" onPointerDown={event => event.stopPropagation()} onClick={() => adjustZoom(1)} className="h-8 w-9 border-b border-slate-200 text-lg font-bold text-slate-700">+</button>
      <button type="button" aria-label="Zoom out" onPointerDown={event => event.stopPropagation()} onClick={() => adjustZoom(-1)} className="h-8 w-9 text-lg font-bold text-slate-700">−</button>
    </div>
    <div role="note" className="absolute inset-x-2 bottom-2 z-[4] flex flex-wrap items-center justify-between gap-1 rounded bg-white/95 px-2 py-1.5 text-[10px] text-slate-700 shadow">
      <span>{mode === "picker" ? "Click or tap to place a pin; drag to move the map." : "Map fallback is active."} {mapError.includes("rejected") ? "Google Maps key referrer restriction." : ""}</span>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="text-slate-600 underline">© OpenStreetMap contributors</a>
    </div>
  </div>;
}

function isValidLocation(location: CommunityAlertMapLocation): location is CommunityAlertMapLocation {
  return Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    location.latitude >= -90 && location.latitude <= 90 &&
    location.longitude >= -180 && location.longitude <= 180;
}
