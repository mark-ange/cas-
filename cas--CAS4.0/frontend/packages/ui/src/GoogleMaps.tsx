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
  locations?: Array<CommunityAlertMapLocation & { area: string }>;
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

function approximateRadiusPixels(latitude: number, zoom: number): number {
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom;
  return APPROXIMATE_AFFECTED_RADIUS_METERS / metersPerPixel;
}

function extendApproximateAreaBounds(bounds: MapsLatLngBounds, location: CommunityAlertMapLocation) {
  const latitudeOffset = APPROXIMATE_AFFECTED_RADIUS_METERS / 111_320;
  const longitudeOffset = latitudeOffset / Math.cos(location.latitude * Math.PI / 180);
  bounds.extend({ lat: location.latitude - latitudeOffset, lng: location.longitude - longitudeOffset });
  bounds.extend({ lat: location.latitude + latitudeOffset, lng: location.longitude + longitudeOffset });
}

function combineAreaLocations(
  locations: Array<CommunityAlertMapLocation & { area: string }>,
): Array<CommunityAlertMapLocation & { area: string }> {
  const grouped = new Map<string, CommunityAlertMapLocation & { area: string }>();
  for (const location of locations) {
    const key = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
    const existing = grouped.get(key);
    if (existing) existing.area = `${existing.area}, ${location.area}`;
    else grouped.set(key, { ...location });
  }
  return [...grouped.values()];
}

function uniqueCoordinates<T extends CommunityAlertMapLocation>(locations: T[]): T[] {
  const seen = new Set<string>();
  return locations.filter(location => {
    const key = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface MapsMarker {
  setMap(map: MapsMapInstance | null): void;
  addListener(eventName: string, handler: () => void): MapsListener;
}

interface MapsCircle {
  setMap(map: MapsMapInstance | null): void;
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
  Circle: new (options: {
    map: MapsMapInstance;
    center: { lat: number; lng: number };
    radius: number;
    clickable: boolean;
    fillColor: string;
    fillOpacity: number;
    strokeColor: string;
    strokeOpacity: number;
    strokeWeight: number;
  }) => MapsCircle;
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
const APPROXIMATE_AFFECTED_RADIUS_METERS = 1200;

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
  selectedAreas,
  areaContext,
  selectedLocation,
  selectedLocations,
  onLocationSelected,
  onLocationsSelected,
  height = 340,
  label,
}: {
  mode: "picker" | "display";
  announcements?: CommunityAlertMapAnnouncement[];
  selectedArea?: string;
  selectedAreas?: string[];
  areaContext?: string;
  selectedLocation?: CommunityAlertMapLocation | null;
  selectedLocations?: CommunityAlertMapLocation[];
  onLocationSelected?: (location: CommunityAlertMapLocation | null) => void;
  onLocationsSelected?: (locations: CommunityAlertMapLocation[] | null) => void;
  height?: number;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onLocationSelectedRef = useRef(onLocationSelected);
  const onLocationsSelectedRef = useRef(onLocationsSelected);
  const selectedLocationsRef = useRef(selectedLocations ?? []);
  const selectedAreasRef = useRef(selectedAreas ?? (selectedArea?.trim() ? [selectedArea] : []));
  const areaContextRef = useRef(areaContext ?? "");
  const pickerMapRef = useRef<MapsMapInstance | null>(null);
  const pickerMapsRef = useRef<GoogleMapsApi | null>(null);
  const selectionMarkersRef = useRef<MapsMarker[]>([]);
  const selectionAreasRef = useRef<MapsCircle[]>([]);
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

  useEffect(() => {
    onLocationsSelectedRef.current = onLocationsSelected;
  }, [onLocationsSelected]);

  useEffect(() => {
    selectedLocationsRef.current = selectedLocations ?? [];
  }, [selectedLocations]);

  useEffect(() => {
    selectedAreasRef.current = selectedAreas ?? (selectedArea?.trim() ? [selectedArea] : []);
    areaContextRef.current = areaContext ?? "";
  }, [areaContext, selectedArea, selectedAreas?.join("\u001f")]);

  const locationsAfterManualPin = (location: CommunityAlertMapLocation): Array<CommunityAlertMapLocation & { area: string }> => {
    const context = areaContextRef.current;
    if (context && selectedAreasRef.current.some(area => area.startsWith(`${context} · `))) {
      return selectedAreasRef.current.map(area => ({ ...location, area }));
    }
    const current = selectedLocationsRef.current;
    const nextArea = selectedAreasRef.current[current.length];
    const labeledCurrent = current.map((selected, index) => ({
      ...selected,
      area: "area" in selected && typeof selected.area === "string"
        ? selected.area
        : selectedAreasRef.current[index] ?? "Selected area",
    }));
    return nextArea
      ? [...labeledCurrent, { ...location, area: nextArea }]
      : [{ ...location, area: selectedAreasRef.current[0] ?? "Selected area" }, ...labeledCurrent.slice(1)];
  };

  // Keep display-mode markers in sync without rebuilding the map on every React render.
  const markerSignature = useMemo(
    () => announcements.map(item => `${item.id}|${item.latitude}|${item.longitude}|${item.title}|${item.area}|${item.status}|${JSON.stringify(item.locations ?? [])}`).join(";"),
    [announcements],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let clickListener: MapsListener | null = null;
    const plottedMarkers: MapsMarker[] = [];
    const plottedAreas: MapsCircle[] = [];
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
          selectionMarkersRef.current.forEach(marker => marker.setMap(null));
          selectionMarkersRef.current = [];
          selectionAreasRef.current.forEach(area => area.setMap(null));
          selectionAreasRef.current = [];
          const locations = locationsAfterManualPin(location);
          combineAreaLocations(locations).forEach(selected => {
            const position = { lat: selected.latitude, lng: selected.longitude };
            selectionAreasRef.current.push(new maps.Circle({
              map,
              center: position,
              radius: APPROXIMATE_AFFECTED_RADIUS_METERS,
              clickable: false,
              fillColor: "#059669",
              fillOpacity: 0.18,
              strokeColor: "#047857",
              strokeOpacity: 0.75,
              strokeWeight: 2,
            }));
            selectionMarkersRef.current.push(new maps.Marker({
              map,
              position,
              title: `${selected.area} · approximate barangay location`,
            }));
          });
          selectedLocationsRef.current = locations;
          onLocationSelectedRef.current?.(location);
          onLocationsSelectedRef.current?.(locations);
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
          for (const location of combineAreaLocations(announcementLocations(announcement))) {
            const position = { lat: location.latitude, lng: location.longitude };
            plottedAreas.push(new maps.Circle({
              map,
              center: position,
              radius: APPROXIMATE_AFFECTED_RADIUS_METERS,
              clickable: false,
              fillColor: "#e11d48",
              fillOpacity: 0.18,
              strokeColor: "#be123c",
              strokeOpacity: 0.7,
              strokeWeight: 2,
            }));
            const marker = new maps.Marker({ map, position, title: announcement.title });
            plottedMarkers.push(marker);
            extendApproximateAreaBounds(bounds, location);
            marker.addListener("click", () => {
            // Use textContent rather than HTML strings to avoid treating advisory text as markup.
            const content = document.createElement("div");
            content.className = "civicalert-map-info";
            const title = document.createElement("strong");
            title.textContent = announcement.title;
            const area = document.createElement("p");
            area.textContent = `${announcement.utility} · ${location.area}`;
            const status = document.createElement("small");
            status.textContent = `Status: ${announcement.status}`;
            content.append(title, area, status);
            infoWindow.setContent(content);
            infoWindow.open({ map, anchor: marker });
          });
          }
        }

        const validLocations = validAnnouncements.flatMap(announcementLocations);
        if (validLocations.length === 1) {
          map.setCenter({ lat: validLocations[0].latitude, lng: validLocations[0].longitude });
          map.setZoom(14);
        } else if (validLocations.length > 1) {
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
      selectionMarkersRef.current.forEach(marker => marker.setMap(null));
      selectionMarkersRef.current = [];
      pickerMapRef.current = null;
      pickerMapsRef.current = null;
      setPickerReady(false);
      for (const marker of plottedMarkers) marker.setMap(null);
      for (const area of plottedAreas) area.setMap(null);
      selectionAreasRef.current.forEach(area => area.setMap(null));
      selectionAreasRef.current = [];
    };
  // The marker signature intentionally describes marker data rather than the array identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, mode, markerSignature]);

  useEffect(() => {
    const areas = selectedAreas ?? (selectedArea?.trim() ? [selectedArea] : []);
    if (mode !== "picker" || areas.length === 0) {
      selectionMarkersRef.current.forEach(marker => marker.setMap(null));
      selectionMarkersRef.current = [];
      selectionAreasRef.current.forEach(area => area.setMap(null));
      selectionAreasRef.current = [];
      setFallbackLocation(null);
      onLocationSelectedRef.current?.(null);
      onLocationsSelectedRef.current?.([]);
      setAreaLookup("idle");
      return;
    }

    if (!pickerReady && !mapError) return;

    const map = pickerMapRef.current;
    const requestId = ++geocodeRequestRef.current;
    const abortController = new AbortController();
    selectionMarkersRef.current.forEach(marker => marker.setMap(null));
    selectionMarkersRef.current = [];
    selectionAreasRef.current.forEach(area => area.setMap(null));
    selectionAreasRef.current = [];
    setFallbackLocation(null);
    setAreaLookup("loading");
    void (async () => {
      let locations: Array<CommunityAlertMapLocation & { area: string }> = areas.map(area => ({
        ...DEFAULT_CAGAYAN_DE_ORO,
        area,
      }));
      const showLocations = (selected: Array<CommunityAlertMapLocation & { area: string }>) => {
        selectionMarkersRef.current.forEach(marker => marker.setMap(null));
        selectionMarkersRef.current = [];
        selectionAreasRef.current.forEach(area => area.setMap(null));
        selectionAreasRef.current = [];
        const maps = pickerMapsRef.current;
        const bounds = maps ? new maps.LatLngBounds() : null;
        selectionMarkersRef.current = selected.flatMap(location => {
          const position = { lat: location.latitude, lng: location.longitude };
          if (bounds) extendApproximateAreaBounds(bounds, location);
          if (!map || !maps) return [];
          selectionAreasRef.current.push(new maps.Circle({
            map,
            center: position,
            radius: APPROXIMATE_AFFECTED_RADIUS_METERS,
            clickable: false,
            fillColor: "#059669",
            fillOpacity: 0.18,
            strokeColor: "#047857",
            strokeOpacity: 0.75,
            strokeWeight: 2,
          }));
          return [new maps.Marker({ map, position, title: `${location.area} · approximate shaded zone` })];
        });
        if (map && bounds && selected.length > 1) map.fitBounds(bounds);
        else if (map && selected[0]) {
          map.setCenter({ lat: selected[0].latitude, lng: selected[0].longitude });
          map.setZoom(14);
        }
        setFallbackLocation(selected[0] ?? null);
        selectedLocationsRef.current = selected;
        onLocationSelectedRef.current?.(selected[0] ?? null);
        onLocationsSelectedRef.current?.(selected);
      };
      showLocations(locations);
      try {
        if (areaContext?.trim() && areas.some(area => area.startsWith(`${areaContext} · `))) {
          const query = new URLSearchParams({
            format: "jsonv2",
            limit: "1",
            q: `${areaContext}, Cagayan de Oro City, Philippines`,
            viewbox: "124.4,8.65,124.9,8.25",
            bounded: "1",
          });
          const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
            headers: { Accept: "application/json" },
            signal: abortController.signal,
          });
          if (!response.ok) throw new Error(`Area lookup returned HTTP ${response.status}.`);
          const results = await response.json() as Array<{ lat: string; lon: string }>;
          if (geocodeRequestRef.current !== requestId) return;
          const latitude = Number(results[0]?.lat);
          const longitude = Number(results[0]?.lon);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
              latitude < 8.25 || latitude > 8.65 || longitude < 124.4 || longitude > 124.9) {
            throw new Error(`Could not locate ${areaContext} within the service region.`);
          }
          locations = areas.map(area => ({ area, latitude, longitude }));
        } else {
          for (const [index, area] of areas.entries()) {
            if (geocodeRequestRef.current !== requestId) return;
            if (index > 0) await new Promise(resolve => window.setTimeout(resolve, 1100));
            const query = new URLSearchParams({
              format: "jsonv2",
              limit: "1",
              q: `${area}, Cagayan de Oro City, Philippines`,
              viewbox: "124.4,8.65,124.9,8.25",
              bounded: "1",
            });
            const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
              headers: { Accept: "application/json" },
              signal: abortController.signal,
            });
            if (!response.ok) throw new Error(`Area lookup returned HTTP ${response.status}.`);
            const results = await response.json() as Array<{ lat: string; lon: string }>;
            if (geocodeRequestRef.current !== requestId) return;
            const latitude = Number(results[0]?.lat);
            const longitude = Number(results[0]?.lon);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
                latitude < 8.25 || latitude > 8.65 || longitude < 124.4 || longitude > 124.9) {
              throw new Error(`Could not locate ${area} within the service region.`);
            }
            locations.push({ area, latitude, longitude });
          }
        }
        if (geocodeRequestRef.current !== requestId) return;
        showLocations(locations);
        setAreaLookup("idle");
      } catch (error) {
        if (abortController.signal.aborted || geocodeRequestRef.current !== requestId) return;
        console.error("Could not automatically locate the selected service areas:", error);
        setAreaLookup("failed");
      }
    })();

    return () => {
      abortController.abort();
      if (geocodeRequestRef.current === requestId) geocodeRequestRef.current += 1;
    };
  }, [areaContext, mapError, mode, pickerReady, selectedArea, selectedAreas?.join("\u001f")]);

  const validAnnouncementCount = announcements.reduce((count, item) =>
    count + announcementLocations(item).filter(isValidLocation).length, 0);

  return <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100" style={{ minHeight: height }}>
    <div ref={containerRef} style={{ height, width: "100%" }} aria-label={mode === "picker" ? "Click the map to select an affected location" : "Map of utility advisories"} />
    {mapError && <FallbackTileMap
      mode={mode}
      announcements={announcements}
      selectedLocations={selectedLocations ?? (selectedLocation ? [selectedLocation] : fallbackLocation ? [fallbackLocation] : [])}
      onLocationSelected={location => {
        geocodeRequestRef.current += 1;
        setAreaLookup("idle");
        setFallbackLocation(location);
        const locations = locationsAfterManualPin(location);
        selectedLocationsRef.current = locations;
        onLocationSelectedRef.current?.(location);
        onLocationsSelectedRef.current?.(locations);
      }}
      height={height}
      label={label}
      mapError={mapError}
    />}
    {label && !mapError && <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-white/95 px-3 py-2 text-xs font-bold text-slate-800 shadow">{label}</div>}
    {loading && !mapError && <div role="status" className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">Loading Google Maps…</div>}
    {mapError && <div className="sr-only" role="status">{mapError}</div>}
    {mode === "picker" && !loading && !mapError && areaLookup === "loading" && <div role="status" className="absolute inset-x-3 bottom-3 rounded-md bg-white/95 p-2 text-xs text-slate-600 shadow">Finding the selected areas and placing their map pins…</div>}
    {mode === "picker" && !loading && areaLookup === "failed" && <div role="alert" className="absolute inset-x-3 bottom-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 shadow">{areaContextRef.current ? "The barangay lookup is unavailable. An approximate city-center location is shown; click the map to move it to the affected barangay." : "Could not automatically locate every selected area. Click the map to place any missing pins one at a time."}</div>}
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
  selectedLocations,
  onLocationSelected,
  height,
  label,
  mapError,
}: {
  mode: "picker" | "display";
  announcements: CommunityAlertMapAnnouncement[];
  selectedLocations: CommunityAlertMapLocation[];
  onLocationSelected: (location: CommunityAlertMapLocation) => void;
  height: number;
  label?: string;
  mapError: string;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; center: CommunityAlertMapLocation; moved: boolean } | null>(null);
  const [center, setCenter] = useState<CommunityAlertMapLocation>(() => {
    if (selectedLocations[0]) return selectedLocations[0];
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
    } else if (selectedLocations[0]) {
      setCenter(selectedLocations[0]);
    }
  // Recenter only when the marker data or selected coordinate changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, announcements.map(item => `${item.id}:${item.latitude}:${item.longitude}:${JSON.stringify(item.locations ?? [])}`).join("|"), selectedLocations.map(location => `${location.latitude}:${location.longitude}`).join("|")]);

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

  const validAnnouncements = announcements.filter(item => announcementLocations(item).some(isValidLocation));

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
    {mode === "display" && validAnnouncements.flatMap(item => combineAreaLocations(announcementLocations(item)).map((location, index) => {
      const position = markerPosition(location);
      const zoneRadius = approximateRadiusPixels(location.latitude, zoom);
      return <button
        key={`${item.id}-${index}`}
        type="button"
        title={`${item.title} — ${location.area}; shaded area is approximate, not an official boundary`}
        aria-label={`${item.title}, ${item.utility}, ${location.area}. Approximate affected area, not an official boundary.`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => setActiveAnnouncement(activeAnnouncement === item.id ? null : item.id)}
        className="absolute z-[2] grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-rose-700 text-sm font-bold text-white"
        style={{ left: position.x, top: position.y, width: 32, height: 32, boxShadow: `0 0 0 ${zoneRadius}px rgba(225, 29, 72, 0.18), 0 0 0 ${zoneRadius + 1}px rgba(190, 18, 60, 0.65), 0 2px 6px rgba(15, 23, 42, .3)` }}
      >•</button>;
    }))}
    {mode === "picker" && uniqueCoordinates(selectedLocations.filter(isValidLocation)).map((location, index) => {
      const pin = markerPosition(location);
      const zoneRadius = approximateRadiusPixels(location.latitude, zoom);
      return <span
        key={`${location.latitude}-${location.longitude}-${index}`}
        role="img"
        aria-label={`Selected location ${index + 1}, with an approximate shaded affected zone, not an official barangay boundary`}
        title="Approximate affected zone; not an official barangay boundary"
        className="pointer-events-none absolute z-[2] grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-emerald-700 text-sm font-bold text-white"
        style={{ left: pin.x, top: pin.y, width: 32, height: 32, boxShadow: `0 0 0 ${zoneRadius}px rgba(5, 150, 105, 0.18), 0 0 0 ${zoneRadius + 1}px rgba(4, 120, 87, 0.65), 0 2px 6px rgba(15, 23, 42, .3)` }}
      >•</span>;
    })}
    {mode === "display" && validAnnouncements.length === 0 && <div className="absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2 rounded-md bg-white/95 px-3 py-2 text-xs text-slate-700 shadow">No announcements have saved coordinates.</div>}
    {activeAnnouncement !== null && (() => {
      const announcement = validAnnouncements.find(item => item.id === activeAnnouncement);
      if (!announcement) return null;
      const position = markerPosition(announcementLocations(announcement)[0]);
      return <div className="pointer-events-none absolute z-[3] max-w-56 -translate-x-1/2 -translate-y-[calc(100%+2.25rem)] rounded-md bg-white px-3 py-2 text-xs text-slate-800 shadow-lg" style={{ left: position.x, top: position.y }}>
        <strong className="block">{announcement.title}</strong>
        <span>{announcement.utility} · {announcement.area}</span>
        <small className="block">Status: {announcement.status}</small>
      </div>;
    })()}
    {label && <div className="pointer-events-none absolute left-3 top-3 z-[4] rounded-md bg-white/95 px-3 py-2 text-xs font-bold text-slate-800 shadow">{label}</div>}
    <div role="note" className="pointer-events-none absolute right-3 top-14 z-[4] max-w-56 rounded-md border border-slate-200 bg-white/95 px-2.5 py-2 text-[10px] leading-4 text-slate-700 shadow">
      <span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${mode === "picker" ? "bg-emerald-600/30 ring-1 ring-emerald-700" : "bg-rose-600/30 ring-1 ring-rose-700"}`} />
      Shaded affected zone is approximate (1.2 km radius), not an official barangay boundary.
    </div>
    <div className="absolute right-3 top-3 z-[4] grid overflow-hidden rounded-md border border-slate-300 bg-white shadow">
      <button type="button" aria-label="Zoom in" onPointerDown={event => event.stopPropagation()} onClick={() => adjustZoom(1)} className="h-8 w-9 border-b border-slate-200 text-lg font-bold text-slate-700">+</button>
      <button type="button" aria-label="Zoom out" onPointerDown={event => event.stopPropagation()} onClick={() => adjustZoom(-1)} className="h-8 w-9 text-lg font-bold text-slate-700">−</button>
    </div>
    <div role="note" className="absolute inset-x-2 bottom-2 z-[4] flex flex-wrap items-center justify-between gap-1 rounded bg-white/95 px-2 py-1.5 text-[10px] text-slate-700 shadow">
      <span>{mode === "picker" ? "Click or tap to place a missing pin or adjust the first pin; drag to move the map." : "Map fallback is active."} {mapError.includes("rejected") ? "Google Maps key referrer restriction." : ""}</span>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="text-slate-600 underline">© OpenStreetMap contributors</a>
    </div>
  </div>;
}

function isValidLocation(location: CommunityAlertMapLocation): location is CommunityAlertMapLocation {
  return Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    location.latitude >= -90 && location.latitude <= 90 &&
    location.longitude >= -180 && location.longitude <= 180;
}

function announcementLocations(announcement: CommunityAlertMapAnnouncement): Array<CommunityAlertMapLocation & { area: string }> {
  const locations = announcement.locations?.length
    ? announcement.locations
    : [{ area: announcement.area, latitude: announcement.latitude, longitude: announcement.longitude }];
  return locations.filter(isValidLocation);
}
