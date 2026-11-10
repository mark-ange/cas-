import { Component, FormEvent, type ErrorInfo, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type Actor,
  type Advisory,
  type NetworkReading,
  type PortalContent,
  type Portal,
  type PortalSettings,
  type ServiceReport,
  type SMSRecord,
  type Status,
  type WorkOrder,
} from "./domainTypes.js";
import { GoogleMap, type CommunityAlertMapAnnouncement, type CommunityAlertMapLocation } from "./GoogleMaps.js";
import { getSupabase } from "./supabase.js";
import { loadAdvisoryImages, supabaseAction } from "./supabaseActions.js";
import "./styles.css";

const DEFAULT_ANNOUNCEMENT_CHANNELS = ["facebook", "instagram", "gmail"];
let portalContent: PortalContent | null = null;

type EmailDeliverySummary = {
  status: string;
  sent: number;
  failed: number;
  errors: Array<{ message: string; count?: number }>;
};

type SocialDeliverySummary = {
  status: string;
  platforms: Array<{ platform: string; status: string; message?: string; permalinkUrl?: string }>;
};

type PortalNotification = {
  message: string;
  type: "success" | "error";
  links?: Array<{ label: string; url: string }>;
  retryInstagramAdvisoryId?: number;
};

type WorkspaceSection = "advisories" | "work orders" | "resident reports" | "network readings" | "inbox";
type WorkspaceErrors = Partial<Record<WorkspaceSection, string>>;

function workspaceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  if (/statement timeout|canceling statement/i.test(message)) {
    return "The database query timed out. Retry in a moment; this does not mean your records were deleted.";
  }
  if (/failed to fetch|networkerror|err_connection_refused|fetch failed/i.test(message)) {
    return "We couldn't connect to the service. Check your internet connection and try again. If the problem continues, contact your service office.";
  }
  return message;
}

function copy(key: string): string {
  const value = portalContent?.copy[key];
  if (value === undefined) throw new Error(`Missing backend copy key: ${key}`);
  return value;
}

function settingsFor(portal: Portal): PortalSettings {
  const settings = portalContent?.settings[portal];
  if (!settings) throw new Error(`Missing backend settings for ${portal}.`);
  return settings;
}

function portalPageAvailable(portal: Portal, page: string): boolean {
  return settingsFor(portal).navigation.some(item => item.key === page)
    || ((portal === "cepalco" || portal === "water") && page === "publish");
}

function requiredSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing application setting: ${name}.`);
  return value;
}

function apiBaseUrl(portal: Portal): string {
  return ({
    resident: import.meta.env.VITE_RESIDENT_API_URL || "http://localhost:4101",
    cepalco: import.meta.env.VITE_CEPALCO_API_URL || "http://localhost:4102",
    water: import.meta.env.VITE_WATER_API_URL || "http://localhost:4103",
  })[portal].replace(/\/+$/, "");
}

function announcementImageUrls(item: Advisory, portal: Portal): string[] {
  const imageUrls = item.imageUrls?.length ? item.imageUrls : item.imageUrl ? [item.imageUrl] : [];
  const imagePortal = portal === "resident"
    ? item.utility === "Water District" ? "water" : "cepalco"
    : portal;
  return imageUrls.map(imageUrl => imageUrl.startsWith("data:")
    ? imageUrl
    : `${apiBaseUrl(imagePortal)}${imageUrl}`);
}

async function readAnnouncementImage(file: FormDataEntryValue): Promise<string> {
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a valid announcement image.");
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > 15_000_000) throw new Error("Choose an image smaller than 15 MB.");
  const toDataUrl = (image: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read the selected image."));
      }
    };

    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(image);
  });

  if (file.size <= 1_000_000 && file.type === "image/jpeg") return toDataUrl(file);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Try another JPEG, PNG, or WebP file.");
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image optimization is unavailable in this browser.");
    let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    for (let dimensionAttempt = 0; dimensionAttempt < 8; dimensionAttempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.76, 0.66, 0.56]) {
        const optimized = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(blob => blob
            ? resolve(blob)
            : reject(new Error("Could not optimize this image. Try another file.")), "image/jpeg", quality);
        });
        if (optimized.size <= 1_000_000) return await toDataUrl(optimized);
      }
      scale *= 0.8;
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This image could not be reduced below 1 MB. Choose a smaller or lower-resolution image.");
}

async function readAnnouncementImages(files: FormDataEntryValue[]): Promise<string[]> {
  const selectedFiles = files.filter((file): file is File => file instanceof File && file.size > 0);
  if (selectedFiles.length > 10) throw new Error("Choose no more than 10 announcement images.");
  return Promise.all(selectedFiles.map(readAnnouncementImage));
}

function AnnouncementImagePicker({
  label,
  helpText,
  className = "",
  labelClass = "",
  inputClass = "",
  previewClass = "",
  onSelectionChange,
}: {
  label: string;
  helpText: string;
  className?: string;
  labelClass?: string;
  inputClass?: string;
  previewClass?: string;
  onSelectionChange?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const previews = useMemo(() => files.map(file => ({ file, url: URL.createObjectURL(file) })), [files]);
  useEffect(() => () => previews.forEach(preview => URL.revokeObjectURL(preview.url)), [previews]);

  function updateFiles(nextFiles: File[]) {
    const input = inputRef.current;
    if (!input) return;
    const transfer = new DataTransfer();
    nextFiles.forEach(file => transfer.items.add(file));
    input.files = transfer.files;
    setFiles(nextFiles);
    setError("");
    onSelectionChange?.();
  }

  function addFiles(input: HTMLInputElement) {
    const incoming = Array.from(input.files ?? []);
    input.value = "";
    if (files.length + incoming.length > 10) {
      updateFiles(files);
      setError("Choose no more than 10 images.");
      return;
    }
    if (incoming.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      updateFiles(files);
      setError("Choose JPEG, PNG, or WebP images only.");
      return;
    }
    if (incoming.some(file => file.size > 15_000_000)) {
      updateFiles(files);
      setError("Choose images smaller than 15 MB each.");
      return;
    }
    updateFiles([...files, ...incoming]);
  }

  return <div className={className}>
    <label className={labelClass}>
      <span>{label} (up to 10)</span>
      <input ref={inputRef} type="file" name="announcementImages" accept="image/jpeg,image/png,image/webp" multiple className={inputClass} onChange={event => addFiles(event.currentTarget)} />
      <small>{helpText}</small>
    </label>
    {error && <p role="alert" className="mt-2 text-xs font-semibold text-red-600">{error}</p>}
    {previews.length > 0 && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {previews.map(({ file, url }, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="relative min-w-0">
        <img src={url} alt={`Selected advisory image ${index + 1}`} className={previewClass || "h-24 w-full rounded-lg border border-slate-200 object-cover"} />
        <button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => updateFiles(files.filter((_, fileIndex) => fileIndex !== index))} className="absolute right-1 top-1 rounded-full bg-slate-900/80 px-2 py-1 text-xs font-bold text-white">×</button>
      </div>)}
    </div>}
  </div>;
}

// ADDED: Convert existing API advisory records into validated map markers.
function mapAnnouncements(advisories: Advisory[]): CommunityAlertMapAnnouncement[] {
  return advisories.flatMap(item => {
    if (item.status !== "Active" ||
        (item.publicationStatus !== undefined && item.publicationStatus !== "published")) return [];
    const located = item as Advisory & { latitude?: unknown; longitude?: unknown };
    if (located.latitude === null || located.latitude === undefined ||
        located.longitude === null || located.longitude === undefined) return [];
    const latitude = Number(located.latitude);
    const longitude = Number(located.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    return [{
      id: item.id,
      title: item.title,
      utility: item.utility,
      area: item.area,
      status: item.status,
      latitude,
      longitude,
    }];
  });
}

function Icon({ name, className = "h-5 w-5" }: { name: string; className?: string }) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z",
    water: "M12 3s7 7 7 12a7 7 0 1 1-14 0c0-5 7-12 7-12Z",
    alert: "M12 3 2.9 19a1.4 1.4 0 0 0 1.2 2.1h15.8a1.4 1.4 0 0 0 1.2-2.1L12 3Zm0 6v4.5m0 3h.01",
    calendar: "M3 5h18v16H3zM8 3v4m8-4v4M3 10h18",
    map: "M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z M12 10h.01",
    people: "M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20m7-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7a4 4 0 0 1 0 7m4 9v-1.5a4 4 0 0 0-3-3.9",
    search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6ZM16 16l5 5",
    plus: "M12 5v14M5 12h14",
    pulse: "M3 12h4l2.4-7 4.2 14 2.5-7H21",
    shield: "M12 2.8 20 6v5.1c0 5.2-3.4 8.8-8 10.2-4.6-1.4-8-5-8-10.2V6l8-3.2Z",
    drop: "M12 3s7 7.1 7 12a7 7 0 1 1-14 0c0-4.9 7-12 7-12Zm-3 13a3 3 0 0 0 3 2",
    close: "m6 6 12 12M18 6 6 18",
    messages: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
    eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Zm10 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    eyeOff: "m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.8M6.2 6.2C3.5 8.1 2 12 2 12s3.6 7 10 7a10.7 10.7 0 0 0 4.1-.8",
    sun: "M12 3v2m0 14v2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42M3 12h2m14 0h2M5.64 18.36l1.42-1.42m9.88-9.88 1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
    moon: "M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z",
  };
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] || paths.home} /></svg>;
}

function CoordinateInputs({
  value,
  onChange,
  className = "",
}: {
  value: CommunityAlertMapLocation | null;
  onChange: (location: CommunityAlertMapLocation | null) => void;
  className?: string;
}) {
  const [latitude, setLatitude] = useState(value ? String(value.latitude) : "");
  const [longitude, setLongitude] = useState(value ? String(value.longitude) : "");

  useEffect(() => {
    if (!value) return;
    setLatitude(String(value.latitude));
    setLongitude(String(value.longitude));
  }, [value?.latitude, value?.longitude]);

  function updateCoordinate(nextLatitude: string, nextLongitude: string) {
    setLatitude(nextLatitude);
    setLongitude(nextLongitude);
    if (!nextLatitude || !nextLongitude) {
      onChange(null);
      return;
    }
    const parsedLatitude = Number(nextLatitude);
    const parsedLongitude = Number(nextLongitude);
    if (Number.isFinite(parsedLatitude) && Number.isFinite(parsedLongitude) &&
        parsedLatitude >= -90 && parsedLatitude <= 90 &&
        parsedLongitude >= -180 && parsedLongitude <= 180) {
      onChange({ latitude: parsedLatitude, longitude: parsedLongitude });
    } else {
      onChange(null);
    }
  }

  return <div className={`mt-3 grid grid-cols-2 gap-3 ${className}`}>
    <label className="text-xs font-semibold text-slate-700">
      Latitude
      <input name="latitude" type="number" step="any" min="-90" max="90" value={latitude}
        onChange={event => updateCoordinate(event.target.value, longitude)}
        className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800"
        placeholder="e.g. 8.4542" />
    </label>
    <label className="text-xs font-semibold text-slate-700">
      Longitude
      <input name="longitude" type="number" step="any" min="-180" max="180" value={longitude}
        onChange={event => updateCoordinate(latitude, event.target.value)}
        className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800"
        placeholder="e.g. 124.6319" />
    </label>
  </div>;
}

async function localAction<T>(portal: Portal, path: string, _token: string | null, options: RequestInit = {}): Promise<T> {
  const backendAction = path === "/email/gmail/status" || path === "/email/gmail/connect" ||
    path === "/social/status" || path.startsWith("/advisories/recipient-estimate") ||
    (portal !== "resident" && (path === "/inbox" || /^\/inbox\/\d+\/read$/.test(path))) ||
    /^\/advisories\/\d+\/(?:email-delivery\/retry|social-publish)$/.test(path);
  if (backendAction) {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (_token) headers.set("Authorization", `Bearer ${_token}`);
    const response = await fetch(`${apiBaseUrl(portal)}${path}`, { ...options, headers });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : `Request failed with status ${response.status}.`;
      throw new Error(message);
    }
    return result as T;
  }
  return supabaseAction<T>(portal, path, options);
}

function Brand({ portal }: { portal: Portal }) {
  return <a href={`/?portal=${portal}`} className="flex items-center gap-3 font-bold tracking-tight text-slate-900 no-underline">
    <span className="brand-symbol grid h-10 w-10 place-items-center rounded-xl bg-[#9f1745] text-white shadow-md"><Icon name="shield" /></span>
    <span>{settingsFor(portal).brand}<small className="mt-0.5 block text-[9px] font-semibold tracking-[.15em] text-slate-500">{copy("copy_64e10aede474")}</small></span>
  </a>;
}

function PasswordInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return <span className="relative block">
    <input {...props} type={visible ? "text" : "password"} className={`${className} pr-12`} />
    <button
      type="button"
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      onClick={() => setVisible(value => !value)}
      className="absolute inset-y-0 right-1 my-auto grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
    ><Icon name={visible ? "eyeOff" : "eye"} className="h-5 w-5" /></button>
  </span>;
}

function ServiceAreaDropdown({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const areas = settingsFor("resident").barangays ?? [];
  const selectedArea = typeof props.value === "string"
    ? props.value
    : typeof props.defaultValue === "string" ? props.defaultValue : "";
  return <select {...props} className={className}>
    <option value="">Select your barangay / service area</option>
    {selectedArea && !areas.includes(selectedArea) && <option value={selectedArea}>{selectedArea}</option>}
    {areas.map(area => <option key={area} value={area}>{area}</option>)}
  </select>;
}

function DistrictDropdown({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const districts = settingsFor("resident").districts ?? [];
  const selectedDistrict = typeof props.value === "string"
    ? props.value
    : typeof props.defaultValue === "string" ? props.defaultValue : "";
  return <select {...props} className={className}>
    <option value="">Select district</option>
    {selectedDistrict && !districts.includes(selectedDistrict) && <option value={selectedDistrict}>{selectedDistrict}</option>}
    {districts.map(district => <option key={district} value={district}>{district}</option>)}
  </select>;
}

function PurokDropdown({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const selectedPurok = typeof props.value === "string"
    ? props.value
    : typeof props.defaultValue === "string" ? props.defaultValue : "";
  return <select {...props} className={className}>
    <option value="">Select purok (optional)</option>
    {selectedPurok && !Array.from({ length: 10 }, (_, index) => String(index + 1)).includes(selectedPurok) &&
      <option value={selectedPurok}>{selectedPurok}</option>}
    {Array.from({ length: 10 }, (_, index) => String(index + 1)).map(purok => <option key={purok} value={purok}>Purok {purok}</option>)}
  </select>;
}

function Login({ portal, onLogin, onRegister, error, busy }: { portal: Portal; onLogin: (event: FormEvent<HTMLFormElement>) => void; onRegister: (event: FormEvent<HTMLFormElement>) => void; error: string; busy: boolean }) {
  if (portal === "resident") return <ResidentAuth onLogin={onLogin} onRegister={onRegister} error={error} busy={busy} />;
  const isWater = portal === "water";
  const isCepalco = portal === "cepalco";
  return <main className={`grid min-h-screen bg-white lg:grid-cols-2 ${isWater ? "water-login" : ""} ${isCepalco ? "cepalco-login" : ""}`}>
    <section className={`login-art relative flex min-h-[260px] flex-col justify-between overflow-hidden bg-gradient-to-br from-rose-900 via-rose-700 to-rose-600 p-7 text-white sm:p-10 lg:min-h-screen lg:px-16 ${isWater ? "auth-water" : ""}`}>
      <Brand portal={portal} />
      <div className="relative z-10 my-auto max-w-lg py-10"><p className="mb-3 text-xs font-bold tracking-[.16em] text-rose-200">{copy("copy_0310fc064cb0")}</p><h1 className="mb-4 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">{isWater ? copy("copy_8344ba8731a9") : copy("copy_c39c90b8a3a9")}</h1><p className="max-w-md text-sm leading-7 text-white/80">{isCepalco ? copy("copy_914bb312bf61") : `Use your assigned ${settingsFor(portal).label} account to manage service advisories and community response.`}</p></div>
      <p className="relative z-10 m-0 text-xs text-white/75">Official utility announcements and resident service information.</p>
    </section>
    <section className="grid place-items-center px-6 py-12"><div className="w-full max-w-md">
      <p className="mb-2 text-[10px] font-extrabold tracking-[.16em] text-[var(--brand)]">{`${settingsFor(portal).label.toUpperCase()} SECURE ACCESS`}</p>
      <h2 className="mb-2 text-2xl font-extrabold text-slate-900">{isCepalco ? copy("copy_fbb349900c63") : `${settingsFor(portal).label} team sign in`}</h2>
      <p className="mb-6 text-sm leading-6 text-slate-500">{copy("copy_8645e230969a")}</p>
      <form onSubmit={onLogin} className="space-y-4">
        <label className="block text-xs font-bold text-slate-700">{copy("copy_5726ba9b0cf2")}<input name="email" type="email" autoComplete="username" required placeholder={copy("copy_7a9b9768f336")} className="mt-2 block w-full rounded-lg border border-slate-200 px-3 py-3 text-sm font-normal outline-none focus:border-[var(--brand)]" /></label>
        <label className="block text-xs font-bold text-slate-700">{copy("copy_e7cf3ef4f17c")}<PasswordInput name="password" autoComplete="current-password" required placeholder={copy("copy_c06bf9670174")} className="mt-2 block w-full rounded-lg border border-slate-200 px-3 py-3 text-sm font-normal outline-none focus:border-[var(--brand)]" /></label>
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--brand-dark)] disabled:opacity-60">{busy ? copy("copy_8b9d3de8ae00") : copy("copy_7455c624c0b2")}</button>
      </form>
      <p className="mt-6 border-t border-slate-100 pt-5 text-center text-xs text-slate-500">{copy("copy_111135c73240")}</p>
    </div></section>
  </main>;
}

function ResidentAuth({ onLogin, onRegister, error, busy }: { onLogin: (event: FormEvent<HTMLFormElement>) => void; onRegister: (event: FormEvent<HTMLFormElement>) => void; error: string; busy: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [localError, setLocalError] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [resetMessage, setResetMessage] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showRegistrationPassword, setShowRegistrationPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const strength = password.length >= 12 && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password)
    ? "Strong" : password.length >= 8 ? "Good" : password.length ? "Needs 8 characters" : "";

  function submitRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setLocalError(copy("copy_6c6e178ad2a8"));
      return;
    }
    setLocalError(copy("copy_e3b0c44298fc"));
    onRegister(event);
  }

  function switchMode(next: "login" | "register") {
    setMode(next);
    setLocalError(copy("copy_e3b0c44298fc"));
    setResetMessage("");
    setPassword("");
    setConfirmPassword("");
    setShowRegistrationPassword(false);
    setShowConfirmPassword(false);
    const formContent = document.querySelector<HTMLElement>(".resident-auth-content");
    if (formContent) formContent.scrollTop = 0;
  }

  async function sendPasswordReset() {
    const email = loginEmail.trim();
    if (!email) {
      setResetMessage("Enter your email address above, then select Forgot password.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setResetMessage("Enter a valid email address first.");
      return;
    }
    setResetBusy(true);
    setResetMessage("");
    try {
      const redirectTo = new URL("/?portal=resident&passwordRecovery=true", window.location.origin).toString();
      const { error: resetError } = await getSupabase().auth.resetPasswordForEmail(email, { redirectTo });
      if (resetError) throw new Error(resetError.message);
      setResetMessage("If an account exists for that email, password reset instructions will be sent.");
    } catch (resetError) {
      setResetMessage(resetError instanceof Error ? resetError.message : "Could not request a password reset. Try again.");
    } finally {
      setResetBusy(false);
    }
  }

  const inputClass = "block w-full rounded-xl border border-slate-300 bg-slate-50/60 px-3.5 py-3 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:bg-white focus:border-rose-600 focus:ring-4 focus:ring-rose-500/15";
  const labelClass = "block text-xs font-bold uppercase tracking-wider text-slate-700";

  return <main className="resident-auth relative min-h-screen flex flex-col justify-center overflow-x-hidden bg-slate-950 text-slate-100 selection:bg-rose-500 selection:text-white">
    {/* Ambient Aurora Glow Lighting */}
    <div className="pointer-events-none absolute -top-40 -left-40 h-[650px] w-[650px] rounded-full bg-rose-600/15 blur-[140px]" />
    <div className="pointer-events-none absolute -bottom-40 -right-40 h-[650px] w-[650px] rounded-full bg-indigo-600/15 blur-[140px]" />
    <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[800px] w-[800px] rounded-full bg-sky-500/5 blur-[160px]" />

    {/* Main Authentication Showcase Container */}
    <section className="resident-auth-wrap relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
      <div className={`resident-auth-card w-full max-w-[1180px] grid overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-2xl transition-all duration-300 lg:grid-cols-[1.05fr_1fr] ${mode === "register" ? "resident-register-card max-w-[1260px] lg:grid-cols-[0.8fr_1.2fr]" : ""}`}>

        {/* Left Panel: Civic Authority & Telemetry Hero */}
        <aside className="resident-auth-art relative flex flex-col justify-between overflow-hidden border-b border-white/10 bg-gradient-to-br from-slate-950 via-slate-900/95 to-slate-900 p-8 text-white sm:p-10 lg:border-b-0 lg:border-r lg:p-12">
          <div className="pointer-events-none absolute inset-0 opacity-10 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:16px_16px]" />

          <div className="relative z-10">
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-rose-400">
              {copy("copy_89ef45eb41e5")}
            </p>
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15">
                <Icon name="shield" className="h-5 w-5 text-rose-300" />
              </span>
              <span className="text-sm font-extrabold tracking-wide">
                {copy("copy_57f90a2f0d6f")}
                <span className="ml-2 font-normal text-slate-300">{copy("copy_a5e005832c4e")}</span>
              </span>
            </div>
          </div>

          <div className="relative z-10 my-8 max-w-lg lg:my-6">
            <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/15 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-rose-300">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />
              {mode === "register" ? copy("copy_82e9d65b52ad") : copy("copy_47a64da286f4")}
            </span>
            <h1 className="mb-4 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
              {mode === "register" ? copy("copy_6abdc4acc7a5") : copy("copy_3ab7b05a2c0a")}
            </h1>
            <p className="mb-6 text-sm leading-relaxed text-slate-300">
              {mode === "register" ? copy("copy_a84c194716ff") : copy("copy_4a5daf58060f")}
            </p>

            {mode === "register" ? (
              <div className="space-y-3.5">
                {requiredSetting(settingsFor("resident").registerHighlights, "resident.registerHighlights").map(({ icon, title, detail }) => (
                  <div key={title} className="flex gap-3.5 rounded-xl border border-white/10 bg-white/5 p-3.5 transition hover:bg-white/10">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/30">
                      <Icon name={icon} className="h-4 w-4" />
                    </span>
                    <div>
                      <strong className="block text-xs font-bold text-white">{title}</strong>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-300">{detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="max-w-md text-sm leading-relaxed text-slate-300">
                Sign in to view current announcements and service information provided by your utility.
              </p>
            )}
          </div>

          <div className="relative z-10 border-t border-white/10 pt-5">
            <p className="m-0 text-[11px] text-slate-400">Community Alert System resident portal.</p>
          </div>
        </aside>

        {/* Right Panel: Clean Modern Authentication Form */}
        <section className="resident-auth-form flex flex-col justify-center bg-white p-6 sm:p-10 lg:p-12 text-slate-900">
          {/* Segmented Mode Switcher */}
          <div className="resident-auth-mode-switcher mb-6 flex rounded-xl bg-slate-100 p-1.5 ring-1 ring-slate-200/80">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
                mode === "login"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950"
              }`}
            >
              {copy("copy_c189840cf7e2")}
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
                mode === "register"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600 hover:text-slate-950"
              }`}
            >
              {copy("copy_798ca2ce18bf")}
            </button>
          </div>

          <div className="resident-auth-content">
          <div className="mb-4 flex items-center justify-between">
            <p className="m-0 rounded-full bg-rose-50 px-3 py-1 text-xs font-bold tracking-wide text-rose-800">
              {mode === "register" ? copy("copy_5278b6dded60") : copy("copy_b80752d1ea40")}
            </p>
            <span className="text-xs text-slate-500">{copy("copy_d6acd37dc90e")}</span>
          </div>

          {mode === "login" ? (
            <>
              <h2 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">
                {copy("copy_54f9715d07d2")}
              </h2>
              <p className="mb-6 text-xs text-slate-500 font-normal">
                {copy("copy_75df0b478fe8")}
              </p>

              <form onSubmit={onLogin} className="space-y-4">
                <label className={labelClass}>
                  {copy("copy_f2488fd4ef4a")}
                  <input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={loginEmail}
                    onChange={event => { setLoginEmail(event.target.value); setResetMessage(""); }}
                    placeholder={copy("copy_7b17fb0bd173")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                <label className={labelClass}>
                  <span>{copy("copy_e7cf3ef4f17c")}</span>
                  <PasswordInput
                    name="password"
                    autoComplete="current-password"
                    required
                    placeholder={copy("copy_c06bf9670174")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                {(error || localError) && (
                  <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs font-semibold text-rose-800">
                    {localError || error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 py-3.5 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-600/25 transition active:scale-[0.99] disabled:opacity-60"
                >
                  {busy ? copy("copy_8b9d3de8ae00") : copy("copy_9ad3f03694b9")}
                </button>
              </form>

              <div className="mt-5 text-center">
                <button
                  type="button"
                  onClick={() => void sendPasswordReset()}
                  disabled={resetBusy}
                  className="text-xs font-bold text-rose-700 hover:underline disabled:opacity-60"
                >
                  {resetBusy ? "Sending reset instructions…" : "Forgot password?"}
                </button>
                {resetMessage && <p role="status" className="mt-2 text-xs text-slate-600">{resetMessage}</p>}
              </div>

            </>
          ) : (
            <>
              <h2 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">
                {copy("copy_8d162b371011")}
              </h2>
              <p className="mb-4 text-xs leading-relaxed text-slate-500">
                {copy("copy_124ed6be4b83")}
              </p>

              <form onSubmit={submitRegistration} className="space-y-3.5">
                <label className={labelClass}>
                  {copy("copy_e52e32bd2ddb")}
                  <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                  <input
                    name="name"
                    required
                    maxLength={120}
                    autoComplete="name"
                    placeholder={copy("copy_d636827b1783")}
                    className={`${inputClass} mt-1.5`}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    {copy("copy_fa12ae8c3d6f")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="phoneNumber"
                      type="tel"
                      required
                      maxLength={40}
                      autoComplete="tel"
                      placeholder={copy("copy_65bc675f13d8")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_21c340f2cd3d")}</small>
                  </label>

                  <label className={labelClass}>
                    {copy("copy_97c04721f9d3")}
                    <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      placeholder={copy("copy_39a22add5269")}
                      className={`${inputClass} mt-1.5`}
                    />
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_f8fe71ad3fc4")}</small>
                  </label>
                </div>

                <fieldset className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <legend className="px-2 text-xs font-bold uppercase tracking-wider text-rose-800">
                    {copy("copy_856936b55ec1")}
                  </legend>
                  <div className="grid gap-3">
                    <label className={labelClass}>
                      {copy("copy_440467b52757")}
                      <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                      <input
                        name="address"
                        required
                        maxLength={240}
                        autoComplete="street-address"
                        placeholder="Street, building, or house number"
                        className={`${inputClass} mt-1.5`}
                      />
                      <small className="mt-1 block text-[11px] font-normal text-slate-500">Enter your house, building, or street address. Select your purok separately below.</small>
                    </label>

                    <div className="grid gap-3 sm:grid-cols-[1fr_130px]">
                      <label className={labelClass}>
                        {copy("copy_52630f30e6ef")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <ServiceAreaDropdown name="barangay" required autoComplete="address-level3" className={`${inputClass} mt-1.5`} />
                      </label>

                      <label className={labelClass}>
                        {copy("copy_18c62c7ea10b")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <input
                          name="postalCode"
                          required
                          maxLength={20}
                          autoComplete="postal-code"
                          placeholder="Postal code"
                          className={`${inputClass} mt-1.5`}
                        />
                      </label>
                    </div>

                    <label className={labelClass}>
                      Purok <span className="font-normal normal-case text-slate-500">(optional)</span>
                      <PurokDropdown name="purok" className={`${inputClass} mt-1.5`} />
                      <small className="mt-1 block text-[11px] font-normal text-slate-500">Your service location is kept in your profile; utility announcements are sent to all residents.</small>
                    </label>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        {copy("copy_338de443b2af")}
                        <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                        <DistrictDropdown name="district" required className={`${inputClass} mt-1.5`} />
                      </label>

                      <label className={labelClass}>
                        {copy("copy_04b621f376b3")}
                        <input
                          name="city"
                          required
                          maxLength={100}
                          placeholder="City or municipality"
                          className={`${inputClass} mt-1.5`}
                        />
                      </label>
                    </div>
                  </div>
                </fieldset>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="resident-registration-password">
                      {copy("copy_68ecf962332c")}
                      <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    </label>
                    <div className="relative mt-1.5">
                      <input
                        id="resident-registration-password"
                        name="password"
                        type={showRegistrationPassword ? "text" : "password"}
                        required
                        minLength={8}
                        autoComplete="new-password"
                        value={password}
                        onChange={event => setPassword(event.target.value)}
                        placeholder={copy("copy_977f3b2676a9")}
                        className={`${inputClass} pr-12`}
                      />
                      <button
                        type="button"
                        aria-label={showRegistrationPassword ? "Hide password" : "Show password"}
                        aria-pressed={showRegistrationPassword}
                        onClick={() => setShowRegistrationPassword(visible => !visible)}
                        className="absolute inset-y-0 right-1 my-auto grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      >
                        <Icon name={showRegistrationPassword ? "eyeOff" : "eye"} className="h-5 w-5" />
                      </button>
                    </div>
                    <small className="mt-1 block text-[11px] font-normal text-slate-500">{copy("copy_aa7e8499fa62")}</small>
                  </div>

                  <div>
                    <label className={labelClass} htmlFor="resident-confirm-password">
                      {copy("copy_b186ebc5096d")}
                      <span className="text-rose-600 ml-1">{copy("copy_684888c0ebb1")}</span>
                    </label>
                    <div className="relative mt-1.5">
                      <input
                        id="resident-confirm-password"
                        name="confirmPassword"
                        type={showConfirmPassword ? "text" : "password"}
                        required
                        minLength={8}
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={event => setConfirmPassword(event.target.value)}
                        placeholder={copy("copy_210dfc7e4536")}
                        className={`${inputClass} pr-12`}
                      />
                      <button
                        type="button"
                        aria-label={showConfirmPassword ? "Hide confirmation password" : "Show confirmation password"}
                        aria-pressed={showConfirmPassword}
                        onClick={() => setShowConfirmPassword(visible => !visible)}
                        className="absolute inset-y-0 right-1 my-auto grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                      >
                        <Icon name={showConfirmPassword ? "eyeOff" : "eye"} className="h-5 w-5" />
                      </button>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <small className="text-[11px] font-semibold text-slate-600">
                        {strength ? `Strength: ${strength}` : copy("copy_551df75ec882")}
                      </small>
                    </div>
                    {/* Visual strength meter bar */}
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full transition-all duration-300 ${
                          strength === "Strong"
                            ? "w-full bg-emerald-500"
                            : strength === "Good"
                            ? "w-2/3 bg-blue-500"
                            : strength
                            ? "w-1/3 bg-amber-500"
                            : "w-0"
                        }`}
                      />
                    </div>
                  </div>
                </div>

                {(error || localError) && (
                  <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                    {localError || error}
                  </p>
                )}

                <div className="space-y-2 pt-1">
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                    <input name="termsAccepted" type="checkbox" required className="mt-0.5 h-4 w-4 rounded accent-rose-600" />
                    <span>
                      {copy("copy_bdb74034a9d2")}
                      <strong className="text-rose-700 ml-1">{copy("copy_add882140045")}</strong>
                      <details className="mt-2 rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] leading-5">
                        <summary className="cursor-pointer font-semibold text-slate-700">Read the Terms and Conditions</summary>
                        <p className="mb-1 mt-2">Community Alert System (CAS) provides utility interruption notices and resident services. Keep your contact details and service address accurate so notices can be matched to your area.</p>
                        <p className="mb-1">Your email is used for advisory notifications. The Resident portal creates a simulated inbox alert for every resident account when a utility publishes an advisory; no SMS text is sent to mobile phones. Announcements may also be published on the responsible utility provider’s official social media accounts.</p>
                        <p className="mb-0">Use the system lawfully and provide accurate information. Community Alert System (CAS) shares service information and does not replace the utility provider’s official authority. Your acceptance time is recorded with your account.</p>
                      </details>
                    </span>
                  </label>

                  <p className="m-0 pl-6 text-slate-500 text-[11px]">{copy("mandatoryAdvisoryEmailInfo")}</p>
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 py-3.5 px-4 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-rose-600/25 transition active:scale-[0.99] disabled:opacity-60"
                >
                  {busy ? copy("copy_f2daf61e527b") : copy("copy_582e329beb8d")}
                </button>
              </form>

              <p className="mt-4 text-center text-xs text-slate-600">
                {copy("copy_04a38dd010ed")}
                <button onClick={() => switchMode("login")} className="font-bold text-rose-700 hover:underline">
                  {copy("copy_3233beba694b")}
                </button>
              </p>

              <p className="mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-400">
                {copy("copy_d66ba85e9208")}
              </p>
            </>
          )}
          </div>
        </section>
      </div>
    </section>

  </main>;
}

function ResidentPasswordRecovery({ onReturnToLogin }: { onReturnToLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const inputClass = "block w-full rounded-xl border border-slate-300 bg-slate-50/60 px-3.5 py-3 text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-rose-600 focus:bg-white focus:ring-4 focus:ring-rose-500/15";

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: updateError } = await getSupabase().auth.updateUser({ password });
      if (updateError) throw new Error(updateError.message);
      const { error: signOutError } = await getSupabase().auth.signOut();
      if (signOutError) throw new Error(signOutError.message);
      setComplete(true);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update your password. Request a new reset link and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="resident-auth grid min-h-screen place-items-center bg-slate-950 p-4 text-slate-900">
    <section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl sm:p-10">
      <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-rose-700">Resident account</p>
      <h1 className="mb-2 text-2xl font-extrabold">{complete ? "Password updated" : "Choose a new password"}</h1>
      {complete ? <>
        <p role="status" className="mb-6 text-sm text-slate-600">Your password has been changed. Sign in with your new password.</p>
        <button type="button" onClick={onReturnToLogin} className="w-full rounded-xl bg-rose-700 px-4 py-3 text-sm font-bold text-white hover:bg-rose-800">Return to sign in</button>
      </> : <>
        <p className="mb-6 text-sm text-slate-600">Enter and confirm your new password.</p>
        <form onSubmit={updatePassword} className="space-y-4">
          <label className="block text-xs font-bold text-slate-700" htmlFor="recovery-password">New password
            <PasswordInput id="recovery-password" autoComplete="new-password" minLength={8} required value={password} onChange={event => setPassword(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>
          <label className="block text-xs font-bold text-slate-700" htmlFor="recovery-confirm-password">Confirm new password
            <PasswordInput id="recovery-confirm-password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} className={`${inputClass} mt-1.5`} />
          </label>
          {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs font-semibold text-rose-800">{error}</p>}
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-rose-700 px-4 py-3 text-sm font-bold text-white hover:bg-rose-800 disabled:opacity-60">{busy ? "Updating password…" : "Update password"}</button>
        </form>
      </>}
    </section>
  </main>;
}

function App({ portal }: { portal: Portal }) {
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("civicalert:theme") === "dark");
  const [token, setToken] = useState<string | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(() =>
    portal === "resident" && new URLSearchParams(location.search).get("passwordRecovery") === "true");
  const [page, setPage] = useState(() => {
    const requestedPage = new URLSearchParams(location.search).get("page") || "overview";
    return portalPageAvailable(portal, requestedPage) ? requestedPage : "overview";
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<{ advisories: Advisory[]; workOrders: WorkOrder[]; reports: ServiceReport[]; network: NetworkReading[] }>({ advisories: [], workOrders: [], reports: [], network: [] });
  const [workspaceErrors, setWorkspaceErrors] = useState<WorkspaceErrors>({});
  const [toast, setToast] = useState<PortalNotification | null>(null);
  const [modal, setModal] = useState<"advisory" | "work" | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retryingInstagramAdvisoryId, setRetryingInstagramAdvisoryId] = useState<number | null>(null);
  const [publishConfirmation, setPublishConfirmation] = useState<string | null>(null);
  const [inbox, setInbox] = useState<SMSRecord[]>([]);
  const pendingPublishConfirmation = useRef<((confirmed: boolean) => void) | null>(null);
  const [publishedDelivery, setPublishedDelivery] = useState<{ advisoryId: number; summary: EmailDeliverySummary } | null>(null);
  const [retryingEmail, setRetryingEmail] = useState(false);
  const isResident = portal === "resident";

  useEffect(() => {
    localStorage.setItem("civicalert:theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    const requestedPage = new URLSearchParams(location.search).get("page") || "overview";
    if (!portalPageAvailable(portal, requestedPage)) {
      history.replaceState({}, "", `/?portal=${portal}&view=portal`);
    }
  }, [portal]);

  function notify(
    message: string,
    type: "success" | "error" = "success",
    links?: Array<{ label: string; url: string }>,
    retryInstagramAdvisoryId?: number,
  ) {
    const notification: PortalNotification = {
      message,
      type,
      ...(links?.length ? { links } : {}),
      ...(retryInstagramAdvisoryId ? { retryInstagramAdvisoryId } : {}),
    };
    setError("");
    setToast(notification);
  }

  useEffect(() => {
    if (!toast || toast.retryInstagramAdvisoryId) return;
    const timeout = window.setTimeout(() => setToast(null), toast.type === "error" ? 12000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    let active = true;
    try {
      const supabase = getSupabase();
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        if (!active) return;
        if (portal === "resident" && event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
        const accessToken = session?.access_token ?? null;
        setToken(accessToken);
        if (accessToken) {
          localStorage.setItem(`civicalert:${portal}:account`, accessToken);
        } else {
          localStorage.removeItem(`civicalert:${portal}:account`);
        }
      });
      void supabase.auth.getSession().then(({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError) {
          setError(sessionError.message);
          return;
        }
        setToken(data.session?.access_token ?? null);
      }).catch(err => {
        if (active) setError(err instanceof Error ? err.message : "Could not restore your Supabase session.");
      });
      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Supabase is not configured.");
    }
  }, [portal]);

  useEffect(() => {
    if (token && actor) void loadWorkspace();
  }, [token, actor]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<{ actor: Actor }>(portal, "/auth/me", token).then(response => {
      if (active) setActor(response.actor);
    }).catch(err => {
      if (!active) return;
      void getSupabase().auth.signOut();
      setActor(null);
      setToken(null);
      setError(err instanceof Error ? err.message : copy("copy_fd2a9a955861"));
    });
    return () => { active = false; };
  }, [token, portal]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const gmailResult = query.get("gmail");
    if (!gmailResult) return;
    const gmailErrors: Record<string, string> = {
      cancelled: "Gmail connection was cancelled.",
      invalid_state: "Gmail connection expired or could not be verified. Start Connect Gmail again.",
      redirect_uri: "Google rejected the callback URL. Confirm the authorized redirect URI exactly matches this API's callback URL.",
      oauth_client: "Google rejected the OAuth client. Check the client ID and secret in the API environment.",
      account_mismatch: "Connect the Gmail account configured as this utility's official sender address.",
      refresh_token: "Google did not provide a refresh token. Reconnect Gmail and approve offline access.",
      server_config: "Gmail OAuth is not fully configured on the API. Check the required Gmail environment variables.",
      invalid_grant: "Google authorization expired or was already used. Start Connect Gmail again.",
      google_error: "Google rejected the authorization request. Check the consent screen, test-user access, and Gmail API setup.",
    };
    const gmailError = query.get("gmailError");
    notify(gmailResult === "connected"
      ? "Official Gmail account connected."
      : gmailErrors[gmailError ?? ""] ?? "Gmail connection did not complete. Check OAuth configuration and try again.");
    query.delete("gmail");
    query.delete("gmailError");
    const remainingQuery = query.toString();
    history.replaceState({}, "", `${location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${location.hash}`);
  }, []);

  async function loadWorkspace() {
    setLoading(true);
    const [advisoriesResult, workOrdersResult, reportsResult, networkResult, inboxResult] = await Promise.allSettled([
      localAction<Advisory[]>(portal, "/advisories", token),
      localAction<WorkOrder[]>(portal, "/work-orders", token),
      localAction<ServiceReport[]>(portal, "/reports", token),
      portal === "water" ? localAction<NetworkReading[]>(portal, "/network", token) : Promise.resolve([] as NetworkReading[]),
      isResident ? localAction<SMSRecord[]>(portal, "/inbox", token) : Promise.resolve([] as SMSRecord[]),
    ]);
    const errors: WorkspaceErrors = {};
    const nextItems = { ...items };
    if (advisoriesResult.status === "fulfilled") nextItems.advisories = advisoriesResult.value;
    else errors.advisories = workspaceErrorMessage(advisoriesResult.reason);
    if (workOrdersResult.status === "fulfilled") nextItems.workOrders = workOrdersResult.value;
    else errors["work orders"] = workspaceErrorMessage(workOrdersResult.reason);
    if (reportsResult.status === "fulfilled") nextItems.reports = reportsResult.value;
    else errors["resident reports"] = workspaceErrorMessage(reportsResult.reason);
    if (networkResult.status === "fulfilled") nextItems.network = networkResult.value;
    else errors["network readings"] = workspaceErrorMessage(networkResult.reason);
    if (inboxResult.status === "fulfilled") {
      if (isResident) setInbox(inboxResult.value);
    }
    else if (isResident) errors.inbox = workspaceErrorMessage(inboxResult.reason);
    setItems(nextItems);
    setWorkspaceErrors(errors);
    if (!Object.keys(errors).length) setError(copy("copy_e3b0c44298fc"));
    setLoading(false);
  }

  function requestPublishConfirmation(message: string): Promise<boolean> {
    return new Promise(resolve => {
      pendingPublishConfirmation.current = resolve;
      setPublishConfirmation(message);
    });
  }

  function resolvePublishConfirmation(confirmed: boolean) {
    const resolve = pendingPublishConfirmation.current;
    pendingPublishConfirmation.current = null;
    setPublishConfirmation(null);
    resolve?.(confirmed);
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const form = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ token: string; actor: Actor }>(portal, "/auth/login", null, { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
      localStorage.setItem(`civicalert:${portal}:account`, response.token);
      setActor(response.actor); setToken(response.token);
      history.replaceState({}, "", `/?portal=${portal}&view=portal`);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_26739f00e5f8"));
    } finally { setBusy(false); }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const data = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ token: string; actor: Actor }>(portal, "/auth/register", null, { method: "POST", body: JSON.stringify({
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
        phoneNumber: data.get("phoneNumber"),
        address: data.get("address"),
        barangay: data.get("barangay"),
        purok: data.get("purok"),
        district: data.get("district"),
        city: data.get("city"),
        postalCode: data.get("postalCode"),
        termsAccepted: data.get("termsAccepted") === "on",
        smsAlerts: true,
      }) });
      localStorage.setItem(`civicalert:${portal}:account`, response.token);
      setActor(response.actor); setToken(response.token);
      history.replaceState({}, "", `/?portal=${portal}&view=portal`);
    } catch (err) { setError(err instanceof Error ? err.message : copy("copy_a4e72985120c")); }
    finally { setBusy(false); }
  }

  function navigate(nextPage: string) {
    if (!portalPageAvailable(portal, nextPage)) return;
    setPage(nextPage); setMobileMenu(false);
    history.pushState({}, "", `/?portal=${portal}&view=portal&page=${nextPage}`);
  }

  async function retryFailedEmails() {
    if (!token || !publishedDelivery) return;
    setRetryingEmail(true);
    setError("");
    try {
      const summary = await localAction<EmailDeliverySummary>(
        portal,
        `/advisories/${publishedDelivery.advisoryId}/email-delivery/retry`,
        token,
        { method: "POST", body: JSON.stringify({}) },
      );
      setPublishedDelivery({ ...publishedDelivery, summary });
      notify(advisoryPublishMessage("", summary), summary.failed > 0 || summary.status === "no_recipients" ? "error" : "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry email delivery.");
    } finally {
      setRetryingEmail(false);
    }
  }

  async function submitRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !modal) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries(form.entries());
    if (modal === "advisory") body.channels = form.getAll("channels").map(String);
    const endpoint = modal === "advisory" ? "/advisories" : "/work-orders";
    try {
      await localAction(portal, endpoint, token, { method: "POST", body: JSON.stringify(body) });
      setModal(null);
      notify(modal === "advisory" ? copy("copy_281a95eb4f15") : copy("copy_05c2120eac8d"));
      await loadWorkspace();
    } catch (err) { setError(err instanceof Error ? err.message : copy("copy_abdb0d7935bb")); }
  }

  async function publishAnnouncement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((portal !== "cepalco" && portal !== "water") || !token) return;
    setBusy(true);
    setError("");
    setToast(null);
    setPublishedDelivery(null);
    const form = new FormData(event.currentTarget);
    try {
      const serviceStartsAt = String(form.get("serviceStartsAt") || "");
      const estimatedRestorationAt = String(form.get("estimatedRestorationAt") || "");
      if (serviceStartsAt && estimatedRestorationAt &&
          new Date(serviceStartsAt).getTime() === new Date(estimatedRestorationAt).getTime()) {
        throw new Error("Advisory start and estimated restoration times cannot be the same.");
      }
      const imageDataUrls = await readAnnouncementImages(form.getAll("announcementImages"));
      const selectedChannels = [...new Set(form.getAll("channels").map(String))];
      if (selectedChannels.length === 0) {
        throw new Error("Select at least one announcement channel.");
      }
      if (selectedChannels.some(channel => ["facebook", "instagram", "gmail"].includes(channel)) && imageDataUrls.length === 0) {
        throw new Error("Add an announcement image before publishing to Facebook, Instagram, or Gmail.");
      }
      const area = String(form.get("area") || "");
      const estimate = await localAction<{ emailRecipients: number }>(portal, "/advisories/recipient-estimate", token);
      const scheduledAtInput = String(form.get("scheduledAt") || "");
      const publishTime = scheduledAtInput ? `Scheduled for ${formatResidentDateTime(new Date(scheduledAtInput).toISOString())}` : "Publish immediately";
      const audience = [
        selectedChannels.includes("gmail") ? `Gmail: ${estimate.emailRecipients} registered residents across all areas` : null,
        selectedChannels.includes("facebook") ? "Facebook: official utility page" : null,
        selectedChannels.includes("instagram") ? "Instagram: official utility account" : null,
      ].filter(Boolean).join("\n");
      const noticePreview = [
        `Location: ${String(form.get("location") || "(Not provided)")}`,
        `Type of Service: ${String(form.get("category") || "(Not provided)")}`,
        `Status: ${String(form.get("serviceStatus") || "(Not provided)")}`,
        `Affecting Area: ${area || "(None listed)"}`,
        `Scheduled Start: ${serviceStartsAt ? formatResidentDateTime(serviceStartsAt) : "(Not provided)"}`,
        `Estimated Restoration: ${estimatedRestorationAt ? formatResidentDateTime(estimatedRestorationAt) : "(Not provided)"}`,
        `Provider: ${String(form.get("provider") || "(Not provided)")}`,
        `Description: ${String(form.get("details") || "(Not provided)")}`,
      ].join("\n");
      const preview = `Review ${portal === "water" ? "Water District" : "CEPALCO"} advisory\n\n${String(form.get("title") || "(No headline)")}\n${noticePreview}\nAudience: all registered residents\n\n${publishTime}\nChannels:\n${audience}\n\nConfirm to save and publish this advisory.`;
      if (!await requestPublishConfirmation(preview)) return;
      const published = await localAction<{
        id: number;
        scheduledAt: string | null;
        facebookUrl?: string | null;
        instagramUrl?: string | null;
        socialLinks?: string[];
        emailDelivery?: EmailDeliverySummary | null;
        socialDelivery?: SocialDeliverySummary | null;
        smsQueued?: number;
      }>(portal, "/advisories", token, {
        method: "POST",
        body: JSON.stringify({
          title: form.get("title"),
          area: form.get("area"),
          type: form.get("category"),
          location: form.get("location"),
          serviceStatus: form.get("serviceStatus"),
          provider: form.get("provider"),
          priority: form.get("priority"),
          serviceStartsAt: serviceStartsAt || null,
          estimatedRestorationAt: estimatedRestorationAt || null,
          details: form.get("details"),
          latitude: form.get("latitude") || null,
          longitude: form.get("longitude") || null,
          imageDataUrls,
          channels: selectedChannels,
          scheduledAt: scheduledAtInput ? new Date(scheduledAtInput).toISOString() : null,
        }),
      });
      if (published.emailDelivery) {
        setPublishedDelivery({ advisoryId: published.id, summary: published.emailDelivery });
      } else {
        setPublishedDelivery(null);
      }
      if (published.scheduledAt) {
        notify(`Announcement scheduled for ${formatResidentDateTime(published.scheduledAt)}. No channel deliveries will start before then.`);
      } else {
        const deliveryResults: string[] = [];
        if (selectedChannels.includes("gmail")) {
          const summary = published.emailDelivery;
          deliveryResults.push(`Gmail: ${summary?.sent ? `${summary.sent} sent${summary.failed ? `, ${summary.failed} failed` : ""}` : summary?.failed ? `${summary.failed} failed` : summary?.status === "no_recipients" ? "not sent; no resident accounts are available" : "not sent"}`);
        }
        const publishedPostLinks = (published.socialDelivery?.platforms ?? []).flatMap(platform => {
          const socialLinkPrefix = platform.platform === "instagram" ? "Instagram: " : "Facebook: ";
          const socialLink = published.socialLinks?.find(link => link.startsWith(socialLinkPrefix))?.slice(socialLinkPrefix.length);
          const fallbackUrl = platform.platform === "instagram"
            ? published.instagramUrl || socialLink
            : published.facebookUrl || socialLink;
          const url = platform.permalinkUrl || fallbackUrl;
          const validUrl = platform.platform === "instagram"
            ? /^https:\/\/(?:www\.)?instagram\.com\//.test(url ?? "")
            : /^https:\/\/(?:www\.)?facebook\.com\//.test(url ?? "");
          if (platform.status !== "published" || !url || !validUrl) return [];
          return [{
            label: `View ${platform.platform === "instagram" ? "Instagram" : "Facebook"} post`,
            url,
          }];
        });
        for (const platform of published.socialDelivery?.platforms ?? []) {
          deliveryResults.push(`${platform.platform}: ${platform.status}${platform.message ? ` (${platform.message})` : ""}`);
        }
        const hasDeliveryFailure = published.socialDelivery?.platforms.some(platform => platform.status !== "published") || Boolean(published.emailDelivery?.failed);
        const outcome = hasDeliveryFailure
          ? "Announcement saved, but one or more channels need attention."
          : "Announcement published successfully.";
        const instagramFailed = selectedChannels.includes("instagram") &&
          published.socialDelivery?.platforms.some(platform => platform.platform === "instagram" && platform.status !== "published");
        const instagramLinkMissing = selectedChannels.includes("instagram") &&
          published.socialDelivery?.platforms.some(platform => platform.platform === "instagram" && platform.status === "published") &&
          !publishedPostLinks.some(link => link.label === "View Instagram post");
        if (instagramLinkMissing) deliveryResults.push("Instagram post link: Meta did not return a permalink yet. Open the advisory and use “Retry Instagram” to retrieve it.");
        const retryInstagramAdvisoryId = instagramFailed || instagramLinkMissing ? published.id : undefined;
        notify(
          [outcome, ...deliveryResults.map(result => `- ${result}`)].join("\n"),
          hasDeliveryFailure ? "error" : "success",
          publishedPostLinks,
          retryInstagramAdvisoryId,
        );
      }
      await loadWorkspace();
      navigate("incidents");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not publish announcement.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateAdvisoryStatus(item: Advisory) {
    const nextStatus: Status = item.status === "Scheduled" ? "Active" : item.status === "Active" ? "Resolved" : item.status === "Resolved" ? "Cancelled" : "Active";
    setError(copy("copy_e3b0c44298fc"));
    try {
      await localAction(portal, `/advisories/${item.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      notify(copy("copy_630120fb8f96").replace("{status}", nextStatus));
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_fc9a5a3ff0fc"));
    }
  }

  async function publishInstagramForAdvisory(item: Advisory | number) {
    if (!token || (portal !== "cepalco" && portal !== "water")) return;
    const advisoryId = typeof item === "number" ? item : item.id;
    setError("");
    setRetryingInstagramAdvisoryId(advisoryId);
    try {
      const result = await localAction<SocialDeliverySummary & { socialLinks?: string[] }>(
        portal,
        `/advisories/${advisoryId}/social-publish`,
        token,
        { method: "POST", body: JSON.stringify({ platforms: ["instagram"] }) },
      );
      const instagram = result.platforms.find(platform => platform.platform === "instagram");
      const savedInstagramLink = result.socialLinks?.find(link => link.startsWith("Instagram: https://"))
        ?.slice("Instagram: ".length);
      const instagramUrl = instagram?.permalinkUrl || savedInstagramLink;
      const links = instagram?.status === "published" && instagramUrl &&
        /^https:\/\/(?:www\.)?instagram\.com\//.test(instagramUrl)
        ? [{ label: "Open Instagram post", url: instagramUrl }]
        : undefined;
      if (instagram?.status === "published") {
        const linkMissing = !links;
        notify(
          links
            ? "Instagram post is published. Use the link below to view it."
            : "Instagram is published, but its link is not available yet. Retry to retrieve the permalink.",
          "success",
          links,
          linkMissing ? advisoryId : undefined,
        );
      } else {
        const reason = instagram?.message || instagram?.status || "publishing failed.";
        const accessTokenError = /decrypted|access token/i.test(reason);
        const tokenName = portal === "water"
          ? "META_INSTAGRAM_ACCESS_TOKEN or WATER_META_INSTAGRAM_ACCESS_TOKEN"
          : "CEPALCO_META_INSTAGRAM_ACCESS_TOKEN";
        const guidance = accessTokenError
          ? ` Set a valid ${tokenName} in the API environment, restart that API, then retry. No post link exists until Instagram publishing succeeds.`
          : "";
        notify(`Instagram could not be published: ${reason}${guidance}`, "error", undefined, advisoryId);
      }
      await loadWorkspace();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Could not publish this advisory to Instagram.";
      notify(`Could not publish this advisory to Instagram: ${reason}`, "error", undefined, advisoryId);
    } finally {
      setRetryingInstagramAdvisoryId(null);
    }
  }

  async function updateReportStatus(item: ServiceReport) {
    if (!token) return;
    const nextStatus: Status = item.status === "Received" ? "Under investigation" : item.status === "Under investigation" ? "Crew dispatched" : item.status === "Crew dispatched" ? "Resolved" : "Received";
    setError(copy("copy_e3b0c44298fc"));
    try {
      await localAction(portal, `/reports/${item.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      notify(copy("copy_a3fb79f419d5").replace("{status}", nextStatus));
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_c1c828c37712"));
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !actor) return;
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const form = new FormData(event.currentTarget);
    try {
      const response = await localAction<{ actor: Actor }>(portal, "/auth/profile", token, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          phoneNumber: form.get("phoneNumber"),
          address: form.get("address"),
          barangay: form.get("barangay"),
          purok: form.get("purok"),
          district: form.get("district"),
          city: form.get("city"),
          postalCode: form.get("postalCode"),
          smsAlerts: true,
          maintenanceAlerts: form.get("maintenanceAlerts") === "on",
          emailDigest: form.get("emailDigest") === "on",
          profileImage: profileImage === null ? actor.profileImage ?? null : profileImage || null,
        }),
      });
      setActor(response.actor);
      setProfileImage(null);
      notify(copy("copy_8a2ad73ece0c"));
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_c2da79d0971c"));
    } finally { setBusy(false); }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true); setError(copy("copy_e3b0c44298fc"));
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") || "");
    const newPassword = String(form.get("newPassword") || "");
    if (newPassword !== form.get("confirmPassword")) {
      setError(copy("copy_8298ff5890a5"));
      setBusy(false);
      return;
    }
    try {
      await localAction(portal, "/auth/password", token, {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      formElement.reset();
      notify(copy("copy_00e34a98f659"));
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("copy_7eb1480a3453"));
    } finally { setBusy(false); }
  }

  function signOut() {
    void getSupabase().auth.signOut();
    localStorage.removeItem(`civicalert:${portal}:account`);
    setActor(null); setToken(null); setItems({ advisories: [], workOrders: [], reports: [], network: [] });
    history.replaceState({}, "", `/?portal=${portal}`);
  }

  if (isResident && passwordRecovery) return <ResidentPasswordRecovery onReturnToLogin={() => {
    setPasswordRecovery(false);
    setActor(null);
    setToken(null);
    localStorage.removeItem(`civicalert:${portal}:account`);
    history.replaceState({}, "", `/?portal=${portal}`);
  }} />;

  if (!token || !actor) return <Login portal={portal} onLogin={login} onRegister={register} error={error} busy={busy} />;

  const nav = settingsFor(portal).navigation;
  const unreadInboxCount = inbox.filter(message => !message.read).length;
  const advisories = items.advisories;
  const activeAdvisories = advisories.filter(item =>
    !["Resolved", "Cancelled", "Operational"].includes(item.status) &&
    (item.publicationStatus === undefined || item.publicationStatus === "published"));
  const currentSettings = settingsFor(portal);
  const mainTitle = currentSettings.pageTitles[page] || currentSettings.pageTitles.overview;
  const pageDescription = currentSettings.pageDescriptions[page] || currentSettings.pageDescriptions.overview;
  const newButton = currentSettings.publishButtonLabel;
  const sectionItems = page === "residents" ? items.reports : advisories;

  return <main className={`portal-${portal} min-h-screen ${darkMode ? "portal-dark" : ""}`}>
    <header className="portal-header sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-7">
      <div className="flex items-center gap-3"><button type="button" onClick={() => setMobileMenu(!mobileMenu)} className="rounded-lg border border-slate-200 p-2 text-slate-600 lg:hidden" aria-label={mobileMenu ? "Close menu" : "Open menu"} aria-expanded={mobileMenu} aria-controls="portal-navigation">{copy("copy_67cfd5703605")}</button><Brand portal={portal} /></div>
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="hidden text-xs text-slate-500 sm:inline">{copy("copy_7a34ff85344e")}</span>
        <button type="button" onClick={() => setDarkMode(mode => !mode)} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} aria-pressed={darkMode} title={darkMode ? "Light mode" : "Dark mode"} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          <Icon name={darkMode ? "sun" : "moon"} className="h-4 w-4" />
          <span className="hidden sm:inline">{darkMode ? "Light mode" : "Dark mode"}</span>
        </button>
        {isResident && <button type="button" onClick={() => navigate("inbox")} aria-label="Open my alerts" title="My alerts" className="relative inline-flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          <Icon name="messages" className="h-4 w-4" />
          <span>My alerts</span>
          {unreadInboxCount > 0 && <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[9px] font-bold text-white">{unreadInboxCount}</span>}
        </button>}
        {isResident ? <button aria-label={`Open profile for ${actor.name}`} onClick={() => navigate("profile")} className="flex items-center gap-2 text-xs font-semibold text-slate-700">{actor.profileImage ? <img src={actor.profileImage} alt="" className="h-8 w-8 rounded-full object-cover" /> : <span aria-hidden="true" className="avatar grid h-8 w-8 place-items-center rounded-full bg-rose-50 text-rose-700">{actor.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}</span>}<span className="hidden sm:inline">{actor.name}</span></button> : <div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><span aria-hidden="true" className="avatar grid h-8 w-8 place-items-center rounded-full bg-rose-50 text-rose-700">{actor.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase()}</span><span className="hidden sm:inline">{actor.name}</span></div>}
      </div>
    </header>
    <div className="portal-layout mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-7 lg:grid-cols-[225px_minmax(0,1fr)] lg:gap-6 lg:py-7">
      <aside id="portal-navigation" className={`portal-sidebar ${mobileMenu ? "fixed inset-y-16 left-0 z-10 block w-[280px] overflow-y-auto shadow-xl" : "hidden"} h-fit rounded-xl border border-slate-200 bg-white p-3 lg:sticky lg:top-20 lg:block`}>
        <p className="px-3 pb-3 pt-2 text-[9px] font-extrabold tracking-[.14em] text-slate-400">{currentSettings.sidebarLabel}</p>
        <nav aria-label="Main menu">{nav.map(({ key, label, icon }) => <button key={key} aria-current={page === key ? "page" : undefined} onClick={() => navigate(key)} className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold ${page === key ? "active-nav bg-rose-50 text-rose-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}><Icon name={icon} className="h-4 w-4" />{label}{(key === "incidents" || (isResident && key === "advisories")) && activeAdvisories.length > 0 && <span className="nav-count ml-auto rounded-full bg-white px-2 py-0.5 text-[9px] text-rose-700">{activeAdvisories.length}</span>}{key === "inbox" && unreadInboxCount > 0 && <span className="nav-count ml-auto rounded-full bg-rose-600 px-2 py-0.5 text-[9px] text-white">{unreadInboxCount}</span>}</button>)}</nav>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-[10px] leading-5 text-slate-500"><strong className="block text-[11px] text-slate-700">{copy("copy_dd5f522c6551")}</strong>{isResident ? copy("copy_e3659a65afce") : copy("copy_053e2c45051b")}</div>
        <button onClick={signOut} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-semibold text-slate-500 hover:bg-slate-50"><Icon name="shield" className="h-4 w-4" />{copy("copy_48f0d3d397d4")}</button>
      </aside>
      <section className="min-w-0">
        <div className="portal-page-heading mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="mb-2 text-[9px] font-extrabold tracking-[.15em] text-[var(--brand)]">{currentSettings.pageHeadingLabel}</p><h1 className="mb-1 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{page === "overview" && isResident ? `${currentSettings.overviewGreetingPrefix} ${actor.name.split(" ")[0]}` : mainTitle}</h1><p className="m-0 text-xs text-slate-500">{pageDescription}</p></div>
          <div className="flex items-center gap-2">{!isResident && (page === "overview" || page === "incidents") && <button type="button" onClick={() => navigate("publish")} className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--brand-dark)]"><Icon name="plus" className="h-4 w-4" />{newButton}</button>}<span className="hidden rounded-full border border-slate-200 bg-white px-3 py-2 text-[10px] font-semibold text-slate-500 md:inline">{new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric" }).format(new Date())}</span></div>
        </div>
        {Object.keys(workspaceErrors).length > 0 && <div role="alert" aria-live="assertive" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm">
          <div className="min-w-0 flex-1">
            <p className="m-0 font-semibold">Some portal data could not be loaded. Counts and lists may be incomplete.</p>
            <ul className="mb-0 mt-2 space-y-1 pl-5 text-xs">{Object.entries(workspaceErrors).map(([section, message]) => <li key={section}><strong className="capitalize">{section}:</strong> {message}</li>)}</ul>
          </div>
          <button type="button" onClick={() => void loadWorkspace()} disabled={loading} className="rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100 disabled:opacity-60">{loading ? "Retrying…" : "Retry loading"}</button>
        </div>}
        {error && token && <div role="alert" aria-live="assertive" className="fixed left-1/2 top-20 z-50 flex w-[min(92vw,36rem)] -translate-x-1/2 items-start justify-between gap-4 rounded-xl border border-rose-300 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-900 shadow-2xl">
          <span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss notification" className="shrink-0 rounded p-1 hover:bg-black/5"><Icon name="close" className="h-4 w-4" /></button>
        </div>}
        {loading && <div className="mb-4 h-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full w-1/3 animate-pulse bg-[var(--brand)]" /></div>}
        {page === "overview" ? <Overview portal={portal} actor={actor} advisories={activeAdvisories} workOrders={items.workOrders} network={items.network} errors={workspaceErrors} onNavigate={navigate} onAction={kind => kind === "advisory" && !isResident ? navigate("publish") : setModal(kind)} /> : page === "inbox" && isResident ? <VirtualInbox messages={inbox} unavailable={workspaceErrors.inbox} onRead={async message => { await localAction(portal, `/inbox/${message.id}/read`, token, { method: "PATCH" }); await loadWorkspace(); }} /> : page === "profile" && isResident ? <ResidentProfile actor={actor} selectedImage={profileImage} saving={busy} onImageChange={setProfileImage} onSave={saveProfile} onPasswordChange={updatePassword} /> : page === "advisories" && isResident ? <ResidentAdvisories items={items.advisories} workOrders={items.workOrders} actor={actor} errors={workspaceErrors} /> : page === "residents" && !isResident && portal === "water" ? <WaterReports reports={items.reports} onStatusUpdate={updateReportStatus} unavailable={workspaceErrors["resident reports"]} /> : page === "residents" && !isResident ? <CepalcoReports reports={items.reports} onStatusUpdate={updateReportStatus} unavailable={workspaceErrors["resident reports"]} /> : (portal === "water" || portal === "cepalco") && page === "publish" ? <WaterPublishForm portal={portal} busy={busy} token={token} onCancel={() => navigate(portal === "cepalco" ? "incidents" : "overview")} onSubmit={publishAnnouncement} /> : portal === "cepalco" && page === "incidents" ? <CepalcoDisruptions items={items.advisories} token={token} onInstagramRetry={publishInstagramForAdvisory} onStatusUpdate={updateAdvisoryStatus} loadError={workspaceErrors.advisories} /> : portal === "water" && page === "incidents" ? <WaterAdvisories items={items.advisories} token={token} onInstagramRetry={publishInstagramForAdvisory} onStatusUpdate={updateAdvisoryStatus} loadError={workspaceErrors.advisories} /> : page === "restoration" && portal === "water" ? <Network portal={portal} advisories={advisories} network={items.network} errors={workspaceErrors} /> : page === "services" ? <Services advisories={items.advisories} unavailable={workspaceErrors.advisories} /> : <section className="space-y-4">
          {page === "incidents" && <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex min-w-[230px] flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-slate-400"><Icon name="search" className="h-4 w-4" /><input className="w-full border-0 bg-transparent text-xs text-slate-800 outline-none" placeholder={copy("copy_7145ac5f783f")} onChange={event => document.querySelectorAll<HTMLElement>("[data-search-item]").forEach(card => { card.hidden = !card.innerText.toLowerCase().includes(event.target.value.toLowerCase()); })} /></label>{!isResident && <button onClick={() => setModal("advisory")} className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-xs font-bold text-white">{copy("copy_dd425feef83c")}{newButton}</button>}</div>}
          <div className="grid gap-3 xl:grid-cols-2">{sectionItems.map(item => <DataCard key={item.id} item={item} page={page} />)}{sectionItems.length === 0 && (page === "residents" && workspaceErrors["resident reports"] ? <SectionUnavailable title="Resident reports" message={workspaceErrors["resident reports"]} /> : <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">{copy("copy_9b2835326f52")}</div>)}</div>
        </section>}
      </section>
    </div>
    {toast && <div role={toast.type === "error" ? "alert" : "status"} aria-live={toast.type === "error" ? "assertive" : "polite"} className={`portal-notification fixed right-4 top-20 z-[51] flex w-[min(92vw,27rem)] items-start gap-3 rounded-2xl border border-l-4 p-4 text-sm shadow-2xl sm:right-6 ${toast.type === "error" ? "border-rose-200 border-l-rose-500 bg-white text-slate-800" : "border-emerald-200 border-l-emerald-500 bg-white text-slate-800"}`}>
      <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${toast.type === "error" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`} aria-hidden="true">
        <Icon name={toast.type === "error" ? "alert" : "shield"} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 font-bold text-slate-900">{toast.type === "error" ? "Needs your attention" : "Action completed"}</p>
        <div className="mt-1 max-h-40 space-y-1 overflow-y-auto break-words text-xs leading-5 text-slate-600">
          {toast.message.split("\n").map((line, index) => <p className="m-0" key={`${index}-${line}`}>{line.replace(/^\s*-\s*/, "")}</p>)}
        </div>
        {toast.links?.length ? <div className="mt-3 flex flex-wrap gap-2">
          {toast.links.map(link => <a key={`${link.label}-${link.url}`} href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-[var(--brand-soft)] px-3 py-2 text-xs font-bold text-[var(--brand)] hover:underline">{link.label}<span aria-hidden="true">↗</span></a>)}
        </div> : null}
        {toast.retryInstagramAdvisoryId && <button type="button" disabled={retryingInstagramAdvisoryId === toast.retryInstagramAdvisoryId} onClick={() => void publishInstagramForAdvisory(toast.retryInstagramAdvisoryId!)} className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60">{retryingInstagramAdvisoryId === toast.retryInstagramAdvisoryId ? "Retrying Instagram…" : "Retry Instagram"}</button>}
        {publishedDelivery?.summary.failed ? <button type="button" onClick={() => void retryFailedEmails()} disabled={retryingEmail} className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60">{retryingEmail ? "Retrying…" : "Retry failed email(s)"}</button> : null}
      </div>
      <button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification" className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Icon name="close" className="h-4 w-4" /></button>
    </div>}
    {publishConfirmation && <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4" onKeyDown={event => {
      if (event.key === "Escape") resolvePublishConfirmation(false);
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="publish-confirmation-title" className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6">
        <h2 id="publish-confirmation-title" className="m-0 text-lg font-bold text-slate-900">Confirm announcement</h2>
        <pre className="my-4 max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-700">{publishConfirmation}</pre>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => resolvePublishConfirmation(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="button" autoFocus onClick={() => resolvePublishConfirmation(true)} className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-dark)]">Confirm &amp; publish</button>
        </div>
      </section>
    </div>}
    {modal && <RecordModal portal={portal} kind={modal} onClose={() => setModal(null)} onSubmit={submitRecord} />}
  </main>;
}

function ResidentProfile({ actor, selectedImage, saving, onImageChange, onSave, onPasswordChange }: { actor: Actor; selectedImage: string | null; saving: boolean; onImageChange: (image: string | null) => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onPasswordChange: (event: FormEvent<HTMLFormElement>) => void }) {
  const [imageError, setImageError] = useState("");
  const image = selectedImage === null ? actor.profileImage : selectedImage || null;
  function selectImage(file?: File) {
    setImageError("");
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 1024 * 1024) {
      setImageError("Choose a JPEG, PNG, or WebP image smaller than 1 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? onImageChange(reader.result) : setImageError("Could not read this image. Please try another file.");
    reader.onerror = () => setImageError("Could not read this image. Please try another file.");
    reader.readAsDataURL(file);
  }
  function downloadProfile() {
    const file = new Blob([JSON.stringify(actor, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "civicalert-resident-profile.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fieldClass = "mt-1.5 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-[#64234f] focus:ring-2 focus:ring-[#64234f]/15 shadow-sm transition-all";
  const labelClass = "block text-xs font-semibold text-slate-700";
  return <div className="resident-profile-page space-y-4">
    <article className="resident-profile-card flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
      {image ? <img src={image} alt={`${actor.name} profile`} className="h-16 w-16 rounded-full border border-slate-200 object-cover shadow-sm" /> : <span className="avatar grid h-16 w-16 place-items-center rounded-full bg-rose-50 text-xl font-bold text-rose-700 shadow-sm">{actor.name.split(" ").map(part => part[0]).slice(0, 2).join("").toUpperCase()}</span>}
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-base font-bold text-slate-900">{actor.name}</strong><span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">{copy("copy_39882d1ad5ec")}</span></div><p className="mb-0 mt-1 text-xs text-slate-500">{actor.barangay || "Barangay not set"}{actor.purok ? ` · Purok ${actor.purok}` : ""}{actor.district ? ` · ${actor.district}` : ""} {copy("copy_6e01f78b9eb4")}{actor.city || "City not set"}</p><p className="mb-0 mt-1 text-xs text-slate-400">{copy("copy_cbbd7f35fdea")}{actor.email}</p></div>
      <div className="flex flex-wrap gap-2"><label className="cursor-pointer rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition-colors">{copy("copy_c5fbcb8b00ea")}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={event => selectImage(event.currentTarget.files?.[0])} /></label>{image && <button type="button" onClick={() => { onImageChange(""); setImageError(""); }} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 shadow-sm transition-colors">{copy("copy_c3812fc4acb8")}</button>}</div>
      {imageError && <p role="alert" className="w-full text-xs font-medium text-rose-700">{imageError}</p>}
    </article>

    <form onSubmit={onSave} className="space-y-4">
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <h2 className="mb-4 mt-0 text-base font-bold text-slate-900">{copy("copy_3a8867786365")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>{copy("copy_f603e86165b0")}<input name="name" required maxLength={120} defaultValue={actor.name} autoComplete="name" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_09bf25ef3083")}<input name="email" type="email" required defaultValue={actor.email} autoComplete="email" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_ba148fbc44de")}<input name="phoneNumber" type="tel" maxLength={40} defaultValue={actor.phoneNumber || ""} autoComplete="tel" className={fieldClass} /></label>
        </div>
      </article>
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-2"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_6f9f42ba937e")}</h2><span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-bold text-violet-700">{copy("copy_8a59897bdc1a")}</span></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={`${labelClass} sm:col-span-2`}>{copy("copy_432d86cc06aa")}<input name="address" maxLength={240} defaultValue={actor.address || ""} autoComplete="street-address" className={fieldClass} /><span className="mt-1 block text-xs font-normal text-slate-500">Include your purok in this address if applicable; notices use it to refine area matching.</span></label>
          <label className={labelClass}>{copy("copy_ad1315f3e999")}<ServiceAreaDropdown name="barangay" required defaultValue={actor.barangay || ""} autoComplete="address-level3" className={fieldClass} /></label>
          <label className={labelClass}>Purok (optional)<PurokDropdown name="purok" defaultValue={actor.purok || ""} className={fieldClass} /><span className="mt-1 block text-xs font-normal text-slate-500">Your service location is kept in your profile; utility announcements are sent to all residents.</span></label>
          <label className={labelClass}>{copy("copy_ac3506fe618c")}<input name="postalCode" maxLength={20} defaultValue={actor.postalCode || ""} autoComplete="postal-code" className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_c4473f4e49d0")}<DistrictDropdown name="district" defaultValue={actor.district || ""} className={fieldClass} /></label>
          <label className={labelClass}>{copy("copy_1f15f6d9f6b5")}<input name="city" maxLength={100} defaultValue={actor.city || ""} autoComplete="address-level2" className={fieldClass} /></label>
        </div>
      </article>
      <article className="resident-profile-card rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_327f37078430")}</h2><p className="mb-0 mt-1 text-xs text-slate-500">{copy("copy_1b1d2a642be6")}</p></div>
        <ProfilePreference name="maintenanceAlerts" checked={actor.maintenanceAlerts ?? true} title={copy("copy_c1d8fd5aca7b")} description={copy("copy_c59d87c00621")} />
        <ProfilePreference name="emailDigest" checked={actor.emailDigest ?? true} title={copy("copy_70c407729c22")} description={copy("copy_379b43036c4a")} />
        <p className="mb-0 mt-3 text-xs text-slate-500">{copy("mandatoryAdvisoryEmailInfo")}</p>
        <p className="mb-0 mt-2 text-xs text-slate-400">{copy("copy_516efbeb02d9")}</p>
      </article>
      <div className="flex justify-end"><button disabled={saving} className="rounded-xl bg-[#64234f] px-6 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-[#521c40] disabled:opacity-60 transition-colors">{saving ? copy("copy_395207583eb8") : copy("copy_1964f29935ed")}</button></div>
    </form>

    <article className="resident-profile-card rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="mb-1 mt-0 text-base font-bold text-slate-900">{copy("copy_766b3efdf18a")}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <form onSubmit={onPasswordChange} className="space-y-3 rounded-lg border border-slate-100 p-4">
          <div className="mb-3"><strong className="block text-sm text-slate-800">{copy("copy_4e70f1fd24ba")}</strong><span className="mt-1 block text-xs text-slate-500">Choose a new password with at least 8 characters.</span></div>
          <div className="grid gap-3">
            <label className="block text-sm font-medium text-slate-700">Current password<PasswordInput name="currentPassword" autoComplete="current-password" required className={`${fieldClass} mt-1`} /></label>
            <label className="block text-sm font-medium text-slate-700">New password<PasswordInput name="newPassword" autoComplete="new-password" minLength={8} required className={`${fieldClass} mt-1`} /></label>
            <label className="block text-sm font-medium text-slate-700">Confirm new password<PasswordInput name="confirmPassword" autoComplete="new-password" minLength={8} required className={`${fieldClass} mt-1`} /></label>
          </div>
          <button disabled={saving} className="mt-1 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-60">{copy("copy_fe45b4014135")}</button>
        </form>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 p-3"><span><strong className="block text-[9px] text-slate-800">{copy("copy_90c788511970")}</strong><small className="mt-1 block text-[8px] text-slate-500">{copy("copy_8600b2680c06")}</small></span><button type="button" disabled title={copy("copy_e215edc152ff")} className="rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-400">{copy("copy_67a926f7008e")}</button></div>
      </div>
    </article>
    <article className="resident-profile-card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:p-5"><div><h2 className="mb-1 mt-0 text-[10px] font-bold text-slate-900">{copy("copy_519ce5a1d593")}</h2><p className="m-0 text-[8px] text-slate-500">{copy("copy_107e0c28b8a3")}</p></div><button type="button" onClick={downloadProfile} className="rounded-md bg-[#64234f] px-3 py-2 text-[8px] font-bold text-white">{copy("copy_5c4238f6a831")}</button></article>
  </div>;
}

function ProfilePreference({ name, checked, title, description }: { name: string; checked: boolean; title: string; description: string }) {
  return <label className="resident-preference flex cursor-pointer items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0">
    <span><strong className="block text-[9px] text-slate-800">{title}</strong><small className="mt-1 block text-[8px] leading-4 text-slate-500">{description}</small></span>
    <input type="checkbox" name={name} defaultChecked={checked} className="resident-preference-input peer sr-only" />
    <span aria-hidden="true" className="resident-toggle shrink-0 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand)]" />
  </label>;
}

function advisoryPublishMessage(
  publishedMessage: string,
  delivery: EmailDeliverySummary,
): string {
  if (delivery.status === "no_recipients") return `${publishedMessage} ${copy("emailDeliveryNoRecipients")}`.trim();
  if (delivery.status === "sent") {
    return `${publishedMessage} ${copy("emailDeliverySent").replace("{sent}", String(delivery.sent))}`.trim();
  }
  if (delivery.status === "partial") {
    return `${publishedMessage} ${copy("emailDeliveryPartial")
      .replace("{sent}", String(delivery.sent))
      .replace("{failed}", String(delivery.failed))}${delivery.errors[0] ? ` ${delivery.errors[0].message}` : ""}`.trim();
  }
  return `${publishedMessage} ${copy("emailDeliveryFailed")
    .replace("{failed}", String(delivery.failed))}${delivery.errors[0] ? ` ${delivery.errors[0].message}` : ""}`.trim();
}

function GmailConnection({ portal, token }: { portal: "cepalco" | "water"; token: string | null }) {
  const [connection, setConnection] = useState<{ connected: boolean; senderEmail: string | null; connectionError?: string | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<typeof connection>(portal, "/email/gmail/status", token).then(result => {
      if (active) setConnection(result);
    }).catch(err => {
      if (active) setError(err instanceof Error ? err.message : copy("gmailConnectionFailed"));
    });
    return () => { active = false; };
  }, [portal, token]);

  async function connect() {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const result = await localAction<{ authorizationUrl: string }>(portal, "/email/gmail/connect", token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : copy("gmailConnectionFailed"));
      setBusy(false);
    }
  }

  return <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span><strong className="block text-[9px] text-slate-800">{copy("gmailConnectionTitle")}</strong><small className="mt-1 block text-[8px] text-slate-500">{copy("gmailConnectionInfo")}</small></span>
      {connection?.connected
        ? <span className="text-[9px] font-semibold text-emerald-700">{copy("gmailConnected")} {connection.senderEmail}</span>
        : <button type="button" onClick={() => void connect()} disabled={busy || !token} className="rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-700 disabled:opacity-60">
            {busy ? copy("gmailConnecting") : copy("gmailConnect")}
          </button>}
    </div>
    {connection?.connected && <button type="button" onClick={() => void connect()} disabled={busy || !token} className="mt-2 rounded-md border border-slate-200 px-3 py-2 text-[8px] font-semibold text-slate-700 disabled:opacity-60">{busy ? copy("gmailConnecting") : copy("gmailReconnect")}</button>}
    {!connection?.connected && !error && <p className="mb-0 mt-2 text-[8px] text-slate-500">{connection?.connectionError || (connection ? copy("gmailNotConnected") : "Checking Gmail connection…")}</p>}
    {error && <p role="alert" className="mb-0 mt-2 text-[8px] text-rose-700">{error}</p>}
  </div>;
}

function SocialConnectionStatus({ portal, token }: { portal: "cepalco" | "water"; token: string | null }) {
  const [status, setStatus] = useState<{
    facebook: boolean;
    instagram: boolean;
    instagramTokenSource: "instagram" | "facebook_page" | "missing";
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    let active = true;
    void localAction<{
      facebook: boolean;
      instagram: boolean;
      instagramTokenSource: "instagram" | "facebook_page" | "missing";
    }>(portal, "/social/status", token)
      .then(result => { if (active) setStatus(result); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not check social publishing setup."); });
    return () => { active = false; };
  }, [portal, token]);

  if (error) return <p role="alert" className="mb-0 text-xs text-rose-700">{error}</p>;
  if (!status) return <p className="mb-0 text-xs text-slate-500">Checking social publishing setup…</p>;
  return <p className="mb-0 text-xs text-slate-600">
    Facebook: <strong className={status.facebook ? "text-emerald-700" : "text-amber-700"}>{status.facebook ? "configured" : "server setup required"}</strong>
    {" · "}
    Instagram: <strong className={status.instagram ? "text-emerald-700" : "text-amber-700"}>{status.instagram ? `configured (${status.instagramTokenSource === "instagram" ? "Instagram token" : "Facebook Page token"})` : "server setup required"}</strong>
    {" · Meta validates the token at publish time; for decryption/validation errors, set a fresh "}
    <code>{portal === "water" ? "META_INSTAGRAM_ACCESS_TOKEN" : "CEPALCO_META_INSTAGRAM_ACCESS_TOKEN"}</code>
    {" in backend/.env and restart the API"}
  </p>;
}

function SectionUnavailable({ title, message }: { title: string; message: string }) {
  return <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
    <strong className="block">{title} are unavailable</strong>
    <span className="mt-1 block text-xs leading-relaxed">{message}</span>
  </div>;
}

function Overview({ portal, actor, advisories, workOrders, network, errors, onNavigate, onAction }: { portal: Portal; actor: Actor; advisories: Advisory[]; workOrders: WorkOrder[]; network: NetworkReading[]; errors: WorkspaceErrors; onNavigate: (page: string) => void; onAction: (modal: "advisory" | "work") => void }) {
  const water = portal === "water";
  const cepalco = portal === "cepalco";
  const resident = portal === "resident";
  if (resident) return <ResidentOverview actor={actor} advisories={advisories} unavailable={errors.advisories} onNavigate={onNavigate} />;
  const averagePressure = network.length
    ? Math.round(network.reduce((sum, reading) => sum + reading.pressurePsi, 0) / network.length)
    : null;
  const activeAdvisoryCount = advisories.filter(item => !["Resolved", "Cancelled"].includes(item.status)).length;
  const configuredMetrics = requiredSetting(settingsFor(portal).metrics, `${portal}.metrics`);
  const metrics = configuredMetrics
    .filter(metric => !water || !["averagePressure", "scheduledMaintenance", "residentReports"].includes(metric.key))
    .map(metric => {
    const value = metric.key === "activeAdvisories"
      ? errors.advisories ? "—" : String(activeAdvisoryCount).padStart(2, "0")
      : metric.key === "activeDisruptions"
          ? errors.advisories ? "—" : String(activeAdvisoryCount).padStart(2, "0")
      : metric.key === "averagePressure"
          ? errors["network readings"] || averagePressure === null ? "—" : `${averagePressure} PSI`
          : metric.key === "scheduledMaintenance"
            ? errors["work orders"] ? "—" : String(workOrders.length).padStart(2, "0")
            : metric.key === "scheduledWorks"
              ? errors["work orders"] ? "—" : String(workOrders.length).padStart(2, "0")
          : "—";
    return { ...metric, value };
    });
  return <div className={`space-y-4 admin-overview ${water ? "water-overview" : ""}`}>
    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">{metrics.map(metric => <article key={metric.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="mb-4 grid h-9 w-9 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name={metric.icon} /></div><strong className="block text-2xl font-extrabold tracking-tight text-slate-900">{metric.value}</strong><span className="mt-1 block text-[10px] text-slate-500">{metric.label}</span></article>)}</section>
    <section className={`grid items-start gap-4 ${cepalco ? "" : "xl:grid-cols-[minmax(0,1fr)_310px]"}`}>
      <div className="space-y-4">
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="m-0 text-base font-bold text-slate-900">{water ? copy("copy_76a36db7bf88") : "Active power advisories"}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_10d5ea350e38")}</p></div><button onClick={() => onNavigate("incidents")} className="text-xs font-bold text-[var(--brand)]">{copy("copy_9a780508debb")}</button></div><div className="space-y-2">{errors.advisories ? <SectionUnavailable title="Advisories" message={errors.advisories} /> : advisories.slice(0, 3).map(item => <DataCard key={item.id} item={item} page="incidents" compact />)}{!errors.advisories && advisories.length === 0 && <Empty message={copy("copy_3678435c18e9")} />}</div></article>
        {water && <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_e9363430f378")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_90ceeef9cb18")}</p></div><button onClick={() => onAction("work")} className="text-xs font-bold text-[var(--brand)]">{copy("copy_311599f38345")}</button></div>{errors["work orders"] ? <SectionUnavailable title="Work orders" message={errors["work orders"]} /> : <WorkTable items={workOrders.slice(0, 3)} />}</article>}
        {water ? <PressureZones readings={network} unavailable={errors["network readings"]} /> : <CepalcoOperationsSummary advisories={advisories} unavailable={errors.advisories} />}
      </div>
      {water && <div className="space-y-4">
        <article className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="mb-4 mt-0 text-sm font-bold text-slate-900">Current service data</h2><div className="space-y-3 text-xs"><HealthLine icon="alert" label="Active advisories" value={errors.advisories ? "Unavailable" : String(activeAdvisoryCount)} /><HealthLine icon={water ? "drop" : "pulse"} label="Network readings" value={errors["network readings"] ? "Unavailable" : network.length ? `${network.length} recorded` : "No readings"} />{water && <HealthLine icon="pulse" label="Average pressure" value={errors["network readings"] ? "Unavailable" : averagePressure === null ? "No readings" : `${averagePressure} PSI`} />}</div></article>
        <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-sm font-bold text-slate-900">{copy("copy_0183aa6e0b13")}</h2><button onClick={() => onNavigate("restoration")} className="text-[10px] font-bold text-[var(--brand)]">{copy("copy_ea488d2693df")}</button></div><MiniMap portal={portal} advisories={advisories} unavailable={errors.advisories} /></article>
        <article className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="mb-3 mt-0 text-sm font-bold text-slate-900">{copy("copy_1810407f5ab7")}</h2><div className="space-y-2">{!resident && <ActionButton icon="plus" label={copy("copy_dd4c1e0f180b")} onClick={() => onNavigate("publish")} />}{!resident && <ActionButton icon="calendar" label={copy("copy_264bf4916de8")} onClick={() => onAction("work")} />}</div></article>
      </div>}
    </section>
  </div>;
}

function CepalcoIncidentCard({ item, compact = false, token, onInstagramRetry, onStatusUpdate }: { item: Advisory; compact?: boolean; token?: string | null; onInstagramRetry?: (item: Advisory) => Promise<void>; onStatusUpdate?: (item: Advisory) => void }) {
  return <StandardAnnouncementCard portal="cepalco" item={item} compact={compact} token={token} onInstagramRetry={onInstagramRetry} onStatusUpdate={onStatusUpdate} />;
}

function CepalcoDisruptions({ items, onStatusUpdate, onInstagramRetry, token, loadError }: { items: Advisory[]; onStatusUpdate: (item: Advisory) => void; onInstagramRetry: (item: Advisory) => Promise<void>; token: string | null; loadError?: string }) {
  const [query, setQuery] = useState("");
  const incidentStatuses = requiredSetting(settingsFor("cepalco").filters?.incidentStatuses, "cepalco.filters.incidentStatuses");
  const [statusFilter, setStatusFilter] = useState(incidentStatuses[0]);
  const filtered = items.filter(item => `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase()) && (statusFilter === "All" || item.status === statusFilter));
  return <section className="cepalco-page-stack admin-page-stack">
    <div className="cepalco-toolbar"><label className="cepalco-search"><Icon name="search" className="h-4 w-4" /><span className="sr-only">Search power advisories</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("copy_7145ac5f783f")} /></label><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label={copy("copy_d96d73ecc01f")}>{incidentStatuses.map(status => <option key={status}>{status}</option>)}</select></div>
    <div className="cepalco-incident-grid">{filtered.map(item => <CepalcoIncidentCard key={item.id} item={item} token={token} onInstagramRetry={onInstagramRetry} onStatusUpdate={onStatusUpdate} />)}{!filtered.length && (loadError ? <SectionUnavailable title="Advisories" message={loadError} /> : <Empty message={copy("copy_e5e64ce05143")} />)}</div>
    <ActivityLog portal="cepalco" token={token} />
  </section>;
}

function minimumLocalDateTime(): string {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function ResidentOverview({ actor, advisories, unavailable, onNavigate }: { actor: Actor; advisories: Advisory[]; unavailable?: string; onNavigate: (page: string) => void }) {
  const activeCount = advisories.filter(item => !["Resolved", "Cancelled"].includes(item.status)).length;
  const metrics = requiredSetting(settingsFor("resident").metrics, "resident.metrics");
  return <div className="resident-workspace space-y-6">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {metrics.map(metric => <article key={metric.key} className="resident-metric-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name={metric.icon} /></span>{!unavailable && activeCount > 0 && <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-700">Attention required</span>}</div><strong className="mt-4 block text-3xl font-extrabold tracking-tight text-slate-900">{unavailable ? "—" : String(activeCount).padStart(2, "0")}</strong><span className="mt-1 block text-xs font-medium text-slate-500">{metric.label}</span></article>)}
    </section>
    <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <article className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_90815a5d5f32")}</h2><p className="mb-0 mt-1 text-xs text-slate-500">{copy("copy_e71ce3f31ff3")}</p></div><button onClick={() => onNavigate("advisories")} className="text-xs font-bold text-[var(--brand)] hover:underline">{copy("copy_63dff5d5a6f2")}</button></div>
        <div className="space-y-4">{unavailable ? <SectionUnavailable title="Advisories" message={unavailable} /> : advisories.slice(0, 3).map(item => <ResidentAdvisoryCard key={item.id} item={item} compact />)}{!unavailable && advisories.length === 0 && <Empty message={copy("copy_a97e0906b67f")} />}</div>
      </article>
      <div className="space-y-5">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-3 flex items-center justify-between"><h2 className="m-0 text-sm font-bold text-slate-900">{copy("copy_4861614144e2")}</h2><span className="text-xs text-slate-500">{unavailable ? "Unavailable" : `${advisories.length} notices`}</span></div>{unavailable ? <SectionUnavailable title="Map locations" message={unavailable} /> : <><GoogleMap mode="display" announcements={mapAnnouncements(advisories)} height={128} label="Published advisory locations" /><p className="mb-0 mt-2 text-xs text-slate-500">{copy("copy_ad386e3eb489")}{actor.barangay || "your registered service area"}{copy("copy_cdb4ee2aea69")}</p></>}</article>
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="mb-4 mt-0 text-sm font-bold text-slate-900">{copy("copy_7ad5d50411ba")}</h2><div className="space-y-3"><HealthLine icon="pulse" label="CEPALCO notices" value={unavailable ? "Unavailable" : `${advisories.filter(item => item.utility === "CEPALCO" && !["Resolved", "Cancelled"].includes(item.status)).length} active`} /><HealthLine icon="drop" label="Water District notices" value={unavailable ? "Unavailable" : `${advisories.filter(item => item.utility === "Water District" && !["Resolved", "Cancelled"].includes(item.status)).length} active`} /></div><button onClick={() => onNavigate("services")} className="mt-4 text-xs font-bold text-[var(--brand)] hover:underline">{copy("copy_bcc07a11eab9")}</button></article>
      </div>
    </section>
  </div>;
}

function ResidentAdvisories({ items, workOrders, actor, errors }: { items: Advisory[]; workOrders: WorkOrder[]; actor: Actor; errors: WorkspaceErrors }) {
  const filterSettings = requiredSetting(settingsFor("resident").filters, "resident.filters");
  const utilityOptions = requiredSetting(filterSettings.utilities, "resident.filters.utilities");
  const statusOptions = requiredSetting(filterSettings.advisoryStatuses, "resident.filters.advisoryStatuses");
  const quickFilters = requiredSetting(filterSettings.quickFilters, "resident.filters.quickFilters");
  const statusQuickFilters = quickFilters.filter(option => !utilityOptions.includes(option));
  const [query, setQuery] = useState("");
  const [utility, setUtility] = useState(utilityOptions[0]);
  const [status, setStatus] = useState(statusOptions[0]);
  const filtered = items.filter(item => {
    const matchesQuery = `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase());
    const matchesUtility = utility === "All" || item.utility === utility;
    const matchesStatus = status === "All" || item.status === status;
    return matchesQuery && matchesUtility && matchesStatus;
  });
  const filteredWorkOrders = workOrders.filter(item => {
    const matchesQuery = `${item.title} ${item.area} ${item.reference} ${item.status}`.toLowerCase().includes(query.toLowerCase());
    const matchesUtility = utility === "All" || item.utility === utility;
    const matchesStatus = status === "All" || status === "Scheduled" || status === item.status;
    return matchesQuery && matchesUtility && matchesStatus;
  });
  const filterClass = "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors";
  return <section className="resident-workspace space-y-5">
    <div className="resident-advisory-tools rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-sm font-bold text-slate-800">Show announcements from</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter announcements by utility">
          {utilityOptions.map(option => {
            const label = option === "All" ? "All" : option === "CEPALCO" ? "Electric" : option === "Water District" ? "Water" : option;
            const selected = utility === option;
            return <button key={option} type="button" aria-pressed={selected} onClick={() => setUtility(option)} className={`${filterClass} ${selected ? "border-[#64234f] bg-[#64234f] text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>{label}</button>;
          })}
        </div>
      </fieldset>
      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <label className="flex min-w-[240px] flex-1 items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-slate-400 focus-within:border-[var(--brand)] focus-within:bg-white"><Icon name="search" className="h-4 w-4" /><input value={query} onChange={event => setQuery(event.target.value)} className="w-full border-0 bg-transparent text-xs text-slate-800 outline-none" placeholder={copy("copy_41d242d68aa1")} /></label>
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">{copy("copy_e1146f006ab3")}<select aria-label={copy("copy_94d5a7703a82")} value={status} onChange={event => setStatus(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-medium text-slate-700 outline-none focus:border-[var(--brand)]">{statusOptions.map(option => <option key={option}>{option}</option>)}</select></label>
      </div>
      {statusQuickFilters.length > 0 && <div className="mt-3.5 flex flex-wrap items-center gap-2"><span className="mr-1 text-xs font-medium text-slate-500">{copy("copy_e1146f006ab3")}</span>{statusQuickFilters.map(option => <button key={option} type="button" aria-pressed={status === option} onClick={() => { setStatus(option); setUtility("All"); }} className={`${filterClass} ${status === option ? "border-[#64234f] bg-[#64234f] text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>{option}</button>)}</div>}
    </div>
    {/* ADDED: Residents can see mapped locations for advisories that include coordinates. */}
    <article className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
      <h2 className="mb-1 mt-0 text-base font-bold text-slate-900">Announcement locations</h2>
      <p className="mb-4 mt-0 text-xs text-slate-500">Select a marker to see its utility, affected area, and status.</p>
      <GoogleMap mode="display" announcements={mapAnnouncements(filtered)} height={320} label="Filtered utility announcements" />
    </article>
    <div className="resident-advisory-grid">{filtered.map(item => <ResidentAdvisoryCard key={`advisory-${item.id}`} item={item} resident={actor} />)}{filteredWorkOrders.map(item => <ResidentWorkCard key={`work-${item.id}`} item={item} />)}{filtered.length + filteredWorkOrders.length === 0 && (errors.advisories ? <SectionUnavailable title="Advisories" message={errors.advisories} /> : errors["work orders"] ? <SectionUnavailable title="Work orders" message={errors["work orders"]} /> : <div className="col-span-full rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">{copy("copy_2559f73c5e19")}</div>)}</div>
  </section>;
}

function ResidentWorkCard({ item }: { item: WorkOrder }) {
  const startsAt = formatResidentDateTime(item.startsAt);
  const endsAt = formatResidentDateTime(item.endsAt);
  return <article className="resident-advisory-card overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm p-4 border-l-4 border-l-violet-500">
    <div className="flex items-center justify-between gap-2 px-3 pt-2"><span className="rounded-full bg-violet-50 border border-violet-200 px-2.5 py-0.5 text-xs font-bold text-violet-800">{item.status}</span><span className="text-xs font-medium text-slate-400">{startsAt}</span></div>
    <div className="px-3 pt-2.5"><p className="mb-1 text-xs font-semibold text-slate-500">{item.utility} {copy("copy_585642cfbba4")}</p><h3 className="m-0 text-sm font-bold leading-snug text-slate-900">{item.title}</h3><p className="mb-2 mt-1 text-xs text-slate-500">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p></div>
    <div className="px-3 pb-3 pt-1"><p className="mb-2 text-xs leading-5 text-slate-600">{copy("copy_cbb05f812c4f")}{startsAt} {copy("copy_4b00b1b86bfd")}{endsAt}{copy("copy_cdb4ee2aea69")}</p><div className="border-t border-slate-100 pt-2 text-xs font-semibold text-slate-600">{copy("copy_e0f3fde9df0e")}{item.utility}</div></div>
  </article>;
}

function formatResidentDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function ResidentAdvisoryCard({ item, compact = false, resident }: { item: Advisory; compact?: boolean; resident?: Actor }) {
  return <StandardAnnouncementCard portal="resident" item={item} compact={compact} resident={resident} />;
}

function StandardAnnouncementCard({
  portal,
  item,
  compact = false,
  resident,
  token,
  onInstagramRetry,
  onStatusUpdate,
}: {
  portal: "resident" | "cepalco" | "water";
  item: Advisory;
  compact?: boolean;
  resident?: Actor;
  token?: string | null;
  onInstagramRetry?: (item: Advisory) => Promise<void>;
  onStatusUpdate?: (item: Advisory) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [instagramRetrying, setInstagramRetrying] = useState(false);
  const [imageUrls, setImageUrls] = useState(() => announcementImageUrls(item, portal));
  const [imageLoadError, setImageLoadError] = useState("");
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const imageLoadAttempted = useRef(imageUrls.length > 0);
  useEffect(() => {
    if (imageLoadAttempted.current) return;
    const media = mediaRef.current;
    if (!media) return;
    let active = true;
    let observer: IntersectionObserver | null = null;
    const loadImages = async () => {
      if (imageLoadAttempted.current) return;
      imageLoadAttempted.current = true;
      try {
        const images = await loadAdvisoryImages(item.id);
        if (active) setImageUrls(announcementImageUrls({ ...item, imageUrls: images }, portal));
      } catch (error) {
        if (active) setImageLoadError(error instanceof Error ? error.message : "Announcement image could not be loaded.");
      }
    };
    if (typeof IntersectionObserver === "undefined") {
      void loadImages();
    } else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer?.disconnect();
          void loadImages();
        }
      }, { rootMargin: "180px" });
      observer.observe(media);
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [item, item.id, portal]);
  const status = item.publicationStatus === "scheduled"
    ? "Scheduled"
    : item.publicationStatus === "failed"
      ? "Publishing failed"
      : item.status;
  const statusTone = status === "Resolved" ? "resolved"
    : status === "Cancelled" ? "cancelled"
      : status === "Scheduled" ? "scheduled"
        : status === "Publishing failed" ? "failed" : "active";
  const showAdminActions = portal !== "resident" && !compact;
  const canUpdateStatus = onStatusUpdate && item.publicationStatus !== "scheduled" && item.publicationStatus !== "failed";
  return <article className={`standard-announcement-card ${compact ? "compact" : ""}`}>
    <div ref={mediaRef} className={`standard-announcement-media ${item.utility === "Water District" ? "water" : "power"}`}>
      {imageUrls.length === 1
        ? <img src={imageUrls[0]} alt={`Announcement: ${item.title}`} />
        : imageUrls.length > 1
          ? <div className="standard-announcement-gallery">{imageUrls.map((imageUrl, index) => <img key={`${imageUrl}-${index}`} src={imageUrl} alt={`Announcement: ${item.title}, image ${index + 1}`} />)}</div>
        : <div className="standard-announcement-placeholder" aria-hidden={imageLoadError ? undefined : "true"}><Icon name={item.utility === "Water District" ? "drop" : "pulse"} /><span>{imageLoadError ? "Image unavailable" : item.utility}</span></div>}
      <div className="standard-announcement-meta">
        <span className={`standard-announcement-status ${statusTone}`}>{status}</span>
        <time>{formatResidentDateTime(item.scheduledAt || item.createdAt)}</time>
      </div>
    </div>
    <div className="standard-announcement-content">
      <div className="standard-announcement-kicker">
        <span>{item.utility} · {item.type}</span>
        <span>{item.priority || "Normal"} priority</span>
      </div>
      <h2>{item.title}</h2>
      <p className="standard-announcement-area">{item.reference} · {item.area}</p>
      {resident && <span className="standard-announcement-match matched">Audience: all residents</span>}
      <dl className="my-3 grid gap-1.5 rounded-lg bg-slate-50 p-3 text-xs text-slate-700 sm:grid-cols-2">
        <div><dt className="inline font-semibold">Location: </dt><dd className="inline">{item.location || item.area}</dd></div>
        <div><dt className="inline font-semibold">Type of Service: </dt><dd className="inline">{item.type}</dd></div>
        <div><dt className="inline font-semibold">Status: </dt><dd className="inline">{item.serviceStatus || item.status}</dd></div>
        <div><dt className="inline font-semibold">Affecting Area: </dt><dd className="inline">{item.area}</dd></div>
        <div><dt className="inline font-semibold">Provider: </dt><dd className="inline">{item.provider || item.utility}</dd></div>
      </dl>
      <p className={`standard-announcement-details ${detailsOpen ? "expanded" : ""}`}>{item.details}</p>
      {(item.serviceStartsAt || item.estimatedRestorationAt) && <p className="standard-announcement-window">
        {item.serviceStartsAt && <>Starts {formatResidentDateTime(item.serviceStartsAt)}</>}
        {item.serviceStartsAt && item.estimatedRestorationAt && <span aria-hidden="true"> · </span>}
        {item.estimatedRestorationAt && <>Est. restoration {formatResidentDateTime(item.estimatedRestorationAt)}</>}
      </p>}
      <SocialPostLinks item={item} />
      {showAdminActions && token && onInstagramRetry && !item.instagramUrl &&
        imageUrls.length > 0 && item.publicationStatus === "published" &&
        <button
          type="button"
          disabled={instagramRetrying}
          onClick={async () => {
            setInstagramRetrying(true);
            try {
              await onInstagramRetry(item);
            } finally {
              setInstagramRetrying(false);
            }
          }}
          className="mb-2.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-[var(--brand)] disabled:opacity-60"
        >{instagramRetrying ? "Publishing to Instagram…" : "Publish to Instagram"}</button>}
      <div className="standard-announcement-actions">
        <button type="button" onClick={() => setDetailsOpen(open => !open)}>
          {detailsOpen ? "Show less" : "Read full notice"}
        </button>
        {showAdminActions && canUpdateStatus && <button type="button" onClick={() => onStatusUpdate?.(item)}>Update status</button>}
      </div>
    </div>
  </article>;
}
function SocialPostLinks({ item }: { item: Advisory }) {
  const links = [
    ["Facebook", item.facebookUrl],
    ["Instagram", item.instagramUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]) && entry[1]!.startsWith("https://"));
  if (!links.length) return null;
  return <nav aria-label="Social media posts" className="mb-2.5 flex flex-wrap gap-2 text-xs font-semibold">
    {links.map(([label, url]) => <a key={label} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700 hover:border-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand)] transition-colors">{`View ${label} post`}</a>)}
  </nav>;
}

function HealthLine({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0 last:pb-0"><span className="flex items-center gap-2 text-slate-600"><Icon name={icon} className="h-4 w-4 text-[var(--brand)]" />{label}</span><strong className="text-[10px] text-slate-800">{value}</strong></div>;
}

function MiniMap({ portal, advisories, unavailable }: { portal: Portal; advisories: Advisory[]; unavailable?: string }) {
  const label = portal === "water" ? "Water advisory locations" : "Utility advisory locations";
  return unavailable ? <SectionUnavailable title="Map locations" message={unavailable} /> : <GoogleMap mode="display" announcements={mapAnnouncements(advisories)} height={128} label={label} />;
}

function PressureZones({ readings, unavailable }: { readings: NetworkReading[]; unavailable?: string }) {
  const networkStatus = requiredSetting(settingsFor("water").networkStatus, "water.networkStatus");
  return <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_befbc9c07735")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">Pressure readings saved by the utility.</p></div>{unavailable ? <SectionUnavailable title="Network readings" message={unavailable} /> : readings.length ? <div className="divide-y divide-slate-100">{readings.map(reading => { const status = reading.pressurePsi < networkStatus.pressureWatchThresholdPsi ? networkStatus.watch : networkStatus.normal; return <div key={reading.district} className="grid grid-cols-[1fr_52px_auto] items-center gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1.1fr_1fr_52px_auto]"><span><strong className="block text-[11px] text-slate-800">{reading.district}</strong><small className="text-[9px] text-slate-500">{reading.area}</small></span><span className="hidden h-1.5 overflow-hidden rounded-full bg-slate-100 sm:block"><i className={`block h-full rounded-full ${status === networkStatus.watch ? "bg-amber-500" : "bg-cyan-600"}`} style={{ width: `${Math.min(100, reading.pressurePsi * 2)}%` }} /></span><strong className="text-[10px] text-slate-800">{reading.pressurePsi} {copy("copy_4533cd03a204")}</strong><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${status === networkStatus.watch ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>{status}</span></div>; })}</div> : <Empty message={copy("copy_e7c9027da829")} />}</article>;
}

function CepalcoOperationsSummary({ advisories, unavailable }: { advisories: Advisory[]; unavailable?: string }) {
  const activeCount = advisories.filter(item => !["Resolved", "Cancelled"].includes(item.status)).length;
  return <article className="rounded-xl border border-slate-200 bg-white p-5">
    <div className="mb-4">
      <h2 className="m-0 text-base font-bold text-slate-900">Advisory operations</h2>
      <p className="mb-0 mt-1 text-[10px] text-slate-500">Counts from saved utility records.</p>
    </div>
    <div className="space-y-3 text-xs">
      <HealthLine icon="alert" label="Active advisories" value={unavailable ? "Unavailable" : String(activeCount)} />
    </div>
  </article>;
}

function ActionButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-left text-[10px] font-semibold text-slate-700 hover:border-[var(--brand)] hover:bg-[var(--brand-soft)]"><span className="text-[var(--brand)]"><Icon name={icon} className="h-4 w-4" /></span>{label}</button>;
}

function Empty({ message }: { message: string }) {
  return <div className="rounded-lg bg-slate-50 p-6 text-center text-xs text-slate-500">{message}</div>;
}

function DataCard({ item, page, compact = false }: { item: Advisory | WorkOrder | ServiceReport; page: string; compact?: boolean }) {
  const isWork = "startsAt" in item;
  const status = item.status;
  return <article data-search-item className={`rounded-xl border border-slate-200 bg-white ${compact ? "p-3" : "p-4"} ${status === "Under investigation" ? "border-l-2 border-l-amber-500" : ""}`}>
    <div className="flex items-start justify-between gap-2"><span className={`rounded-full px-2 py-1 text-[9px] font-bold ${status === "Resolved" ? "bg-emerald-50 text-emerald-800" : status === "Under investigation" ? "bg-amber-50 text-amber-800" : "bg-[var(--brand-soft)] text-[var(--brand)]"}`}>{isWork ? item.status : (item as Advisory | ServiceReport).status}</span><span className="text-[9px] text-slate-400">{isWork ? item.startsAt : formatResidentDateTime((item as Advisory).scheduledAt || (item as Advisory | ServiceReport).createdAt)}</span></div>
    <h3 className="mb-1 mt-2 text-sm font-bold text-slate-900">{item.title}</h3><p className="mb-2 text-[10px] text-slate-500">{item.reference} {copy("copy_6e01f78b9eb4")}{item.area}</p>
    {!compact && <div className="flex flex-wrap gap-2 text-[9px] text-slate-500"><span>{item.utility}</span>{!isWork && "details" in item && <span>{copy("copy_6e01f78b9eb4")}{item.details}</span>}{isWork && <span>{copy("copy_d33b48f8d23c")}{item.endsAt}</span>}</div>}
  </article>;
}

function WaterAdvisories({ items, token, onStatusUpdate, onInstagramRetry, loadError }: { items: Advisory[]; token: string | null; onStatusUpdate: (item: Advisory) => void; onInstagramRetry: (item: Advisory) => Promise<void>; loadError?: string }) {
  const [query, setQuery] = useState("");
  const [featuredOpen, setFeaturedOpen] = useState(false);
  const filtered = items.filter(item => `${item.title} ${item.area} ${item.reference} ${item.details}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="water-page water-advisories admin-page-stack">
    <label className="water-search"><Icon name="search" className="h-4 w-4" /><span className="sr-only">Search water advisories</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("copy_7145ac5f783f")} /></label>
    <article className="water-featured">
      <div><span>{copy("copy_827ea98e475e")}</span><p>{copy("copy_39b70c211aad")}</p></div>
      <button type="button" onClick={() => setFeaturedOpen(!featuredOpen)}>{featuredOpen ? copy("copy_e0ea6e4875f8") : copy("copy_774a3a596063")}</button>
      {featuredOpen && <p className="water-featured-details">{copy("copy_917ffee3fc75")}</p>}
    </article>
    <div className="water-advisory-grid">
      {filtered.map(item => <WaterAdvisoryCard key={item.id} item={item} token={token} onInstagramRetry={onInstagramRetry} onStatusUpdate={onStatusUpdate} />)}
      {filtered.length === 0 && (loadError ? <SectionUnavailable title="Advisories" message={loadError} /> : <div className="water-empty">{copy("copy_b371347d3915")}</div>)}
    </div>
    <ActivityLog portal="water" token={token} />
  </section>;
}

function ActivityLog({ portal, token }: { portal: "cepalco" | "water"; token: string | null }) {
  const [entries, setEntries] = useState<Array<{ id: number; action: string; summary: string; createdAt: string }>>([]);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    if (!token) return;
    void localAction<Array<{ id: number; action: string; summary: string; createdAt: string }>>(portal, "/activity", token)
      .then(result => { if (active) { setEntries(result); setLoadError(""); } })
      .catch(error => { if (active) { setEntries([]); setLoadError(error instanceof Error ? error.message : "Activity history is unavailable."); } });
    return () => { active = false; };
  }, [portal, token]);
  return <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="m-0 text-sm font-bold text-slate-900">Activity log</h2>
    <p className="mb-3 mt-1 text-xs text-slate-500">Recent advisory publishing and status changes for this utility.</p>
    {loadError ? <p role="status" className="mb-0 text-xs text-amber-800">Activity history is unavailable: {loadError}. Apply the activity log database migration to enable it.</p> : entries.length ? <ol className="m-0 space-y-2 p-0">{entries.map(entry => <li key={entry.id} className="list-none border-t border-slate-100 pt-2 text-xs"><div className="flex flex-wrap justify-between gap-2"><strong className="text-slate-800">{entry.action}</strong><time className="text-slate-400">{formatResidentDateTime(entry.createdAt)}</time></div><ActivitySummary action={entry.action} summary={entry.summary} /></li>)}</ol> : <p className="mb-0 text-xs text-slate-500">No activity has been recorded yet.</p>}
  </section>;
}

function ActivitySummary({ action, summary }: { action: string; summary: string }) {
  if (action !== "Notification dispatch results") {
    return <p className="mb-0 mt-1 break-words text-slate-600">{summary}</p>;
  }
  try {
    const result: unknown = JSON.parse(summary);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid notification summary.");
    const record = result as Record<string, unknown>;
    const email = record.email && typeof record.email === "object" ? record.email as Record<string, unknown> : null;
    const social = record.social && typeof record.social === "object" ? record.social as Record<string, unknown> : null;
    const platforms = Array.isArray(social?.platforms) ? social.platforms as Array<Record<string, unknown>> : [];
    const messages = [
      email ? `Email: ${Number(email.sent) || 0} sent${Number(email.failed) ? `, ${Number(email.failed)} failed` : ""}` : "",
      ...platforms.map(platform => `${String(platform.platform || "Social")}: ${String(platform.status || "unknown")}`),
      Number(record.simulatedSmsRecords) ? `Simulated SMS: ${Number(record.simulatedSmsRecords)} queued` : "",
    ].filter(Boolean);
    return <div className="mt-2">
      <p className="mb-0 break-words font-medium text-slate-700">{messages.join(" · ") || "No channel delivery details were recorded."}</p>
      <details className="mt-1">
        <summary className="w-fit cursor-pointer text-[11px] font-semibold text-slate-500 hover:text-slate-800">View delivery details</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-600">{JSON.stringify(record, null, 2)}</pre>
      </details>
    </div>;
  } catch {
    return <details className="mt-2">
      <summary className="w-fit cursor-pointer text-[11px] font-semibold text-amber-800">Delivery summary could not be formatted</summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-amber-50 p-3 text-[10px] leading-relaxed text-amber-950">{summary}</pre>
    </details>;
  }
}

function WaterAdvisoryCard({ item, token, onInstagramRetry, onStatusUpdate }: { item: Advisory; token: string | null; onInstagramRetry: (item: Advisory) => Promise<void>; onStatusUpdate: (item: Advisory) => void }) {
  return <StandardAnnouncementCard portal="water" item={item} token={token} onInstagramRetry={onInstagramRetry} onStatusUpdate={onStatusUpdate} />;
}

function CepalcoReports({ reports, onStatusUpdate, unavailable }: { reports: ServiceReport[]; onStatusUpdate: (report: ServiceReport) => void; unavailable?: string }) {
  return <section className="grid gap-3 xl:grid-cols-2">
    {unavailable ? <SectionUnavailable title="Resident reports" message={unavailable} /> : reports.map(report => <article key={report.id} className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3"><span className="rounded-full bg-amber-50 px-2 py-1 text-[9px] font-bold text-amber-800">{report.status}</span><time className="text-[9px] text-slate-400">{formatResidentDateTime(report.createdAt)}</time></div>
      <h2 className="mb-1 mt-3 text-sm font-bold text-slate-900">{report.title}</h2><p className="mb-2 text-[10px] text-slate-500">{report.reference} · {report.area}</p>
      {report.details && <p className="text-xs leading-relaxed text-slate-600">{report.details}</p>}
      <button type="button" onClick={() => onStatusUpdate(report)} className="mt-3 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-[var(--brand)] hover:bg-[var(--brand-soft)]">Update report status</button>
    </article>)}
    {!unavailable && reports.length === 0 && <Empty message="No resident reports have been submitted yet." />}
  </section>;
}

function WaterReports({ reports, onStatusUpdate, unavailable }: { reports: ServiceReport[]; onStatusUpdate: (report: ServiceReport) => void; unavailable?: string }) {
  return <section className="water-page water-reports admin-page-stack">
    <div className="water-report-grid">
      {!unavailable && reports.map(report => <article className="water-report-card" key={report.id}>
        <div className="water-report-cover" aria-hidden="true"><span className="water-report-cover-mark"><Icon name="drop" className="h-9 w-9" /></span><span className="water-report-cover-label">Water service report</span></div>
        <div className="water-report-content">
          <div className="water-report-card-meta"><span className={`water-status ${report.status === "Resolved" ? "resolved" : report.status === "Crew dispatched" ? "dispatched" : "received"}`}>{report.status}</span><time>{formatResidentDateTime(report.createdAt)}</time></div>
          <h2>{report.title}</h2>
          <p className="water-card-ref"><Icon name="map" className="h-4 w-4" />{report.area}<span>{report.reference}</span></p>
          <p className="water-card-copy">{report.details || "No additional details were provided."}</p>
          <button type="button" className="water-report-action" onClick={() => onStatusUpdate(report)}>{report.status === "Resolved" ? copy("copy_3d28239a59cc") : copy("copy_029ff7cd00e9")}</button>
        </div>
      </article>)}
    </div>
    {unavailable ? <SectionUnavailable title="Resident reports" message={unavailable} /> : reports.length === 0 && <div className="water-empty">{copy("copy_e082c3906119")}</div>}
  </section>;
}
function WaterPublishForm({ portal, busy, token, onCancel, onSubmit }: { portal: "water" | "cepalco"; busy: boolean; token: string | null; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const isWater = portal === "water";
  const utilityName = isWater ? "Water District" : "CEPALCO";
  const categories = requiredSetting(settingsFor(portal).categories, `${portal}.categories`);
  const priorities = requiredSetting(settingsFor(portal).priorities, `${portal}.priorities`);
  const [category, setCategory] = useState(() => readAnnouncementDraftValue(portal, "category") || categories[0]?.value || "");
  const [selectedArea, setSelectedArea] = useState(() => readAnnouncementDraftValue(portal, "area"));
  const [draftSaved, setDraftSaved] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<CommunityAlertMapLocation | null>(null);
  const [channels, setChannels] = useState<string[]>(() => readAnnouncementDraftChannels(portal));
  const [schedule, setSchedule] = useState(() => readAnnouncementDraftValue(portal, "schedule") === "true");
  const [detailsLength, setDetailsLength] = useState(() => readAnnouncementDraftValue(portal, "details").length);
  const [serviceStartsAt, setServiceStartsAt] = useState(() => readAnnouncementDraftValue(portal, "serviceStartsAt"));
  const [estimatedRestorationAt, setEstimatedRestorationAt] = useState(() => readAnnouncementDraftValue(portal, "estimatedRestorationAt"));
  const serviceStatuses = ["Upcoming Maintenance Interruption", "Active Service Interruption", "Resolved", "Cancelled"];
  const saveDraft = (form: HTMLFormElement | null) => {
    if (!form) return;
    new FormData(form).forEach((value, name) => {
      if (value instanceof File || name === "channels") return;
      localStorage.setItem(`civicalert:${portal}:draft:${name}`, String(value));
    });
    localStorage.setItem(`civicalert:${portal}:draft:category`, category);
    localStorage.setItem(`civicalert:${portal}:draft:schedule`, String(schedule));
    localStorage.setItem(`civicalert:${portal}:draft:channels`, channels.join("|"));
    setDraftSaved(true);
  };
  const toggleChannel = (channel: string) => {
    setChannels(current => current.includes(channel)
      ? current.filter(value => value !== channel)
      : [...current, channel]);
    setDraftSaved(false);
  };
  return <form className={`water-page water-publish-form ${isWater ? "" : "cepalco-publish-layout"}`} onSubmit={onSubmit}>
    <div className="water-publish-top"><div><span>{utilityName.toUpperCase()} OPERATIONS / PUBLIC NOTICES</span><h2>{isWater ? "Publish water advisory" : "Publish service advisory"}</h2></div><div><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={event => saveDraft(event.currentTarget.form)}>Save draft</button><button type="submit" className="water-primary" disabled={busy}>{busy ? "Publishing…" : isWater ? "Publish advisory" : "Publish announcement"}</button></div></div>
    <section className="water-form-card">
      <div><h3>Classify the service update</h3><p>Choose the advisory type and response priority for this notice.</p></div>
      <div className="water-category-grid">{categories.map(({ value, description }) => <button type="button" aria-pressed={category === value} className={category === value ? "selected" : ""} key={value} onClick={() => { setCategory(value); setDraftSaved(false); }}><strong>{value}</strong><small>{description}</small></button>)}</div>
      <input type="hidden" name="category" value={category} />
      <label><span>Priority</span><select name="priority" defaultValue={readAnnouncementDraftValue(portal, "priority") || (isWater ? "Urgent" : "High")} onChange={() => setDraftSaved(false)}>{priorities.map(priority => <option key={priority}>{priority}</option>)}</select></label>
    </section>
    <section className="water-form-card">
      <div><h3>What is happening?</h3><p>Give the update a short title. It will be shared with all residents.</p></div>
      <label><span>Advisory headline</span><input name="title" required maxLength={160} defaultValue={readAnnouncementDraftValue(portal, "title")} onChange={() => setDraftSaved(false)} placeholder="Summarize the service update" /></label>
      <label><span>Location (barangay and city)</span><input name="location" required maxLength={160} defaultValue={readAnnouncementDraftValue(portal, "location")} onChange={() => setDraftSaved(false)} placeholder="For example, Carmen, Cagayan de Oro City" /></label>
      <label><span>Affected barangay or service area</span><ServiceAreaDropdown name="area" required value={selectedArea} onChange={event => { setSelectedArea(event.target.value); setSelectedLocation(null); setDraftSaved(false); }} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm font-normal text-slate-800" /></label>
      <label><span>Service status</span><select name="serviceStatus" required defaultValue={readAnnouncementDraftValue(portal, "serviceStatus") || serviceStatuses[0]} onChange={() => setDraftSaved(false)}>{serviceStatuses.map(status => <option key={status}>{status}</option>)}</select></label>
    </section>
    <section className="water-form-card">
      <div><h3>When will service be affected?</h3><p>Choose the service provider. Add times when known; you can leave either time blank if it is not confirmed.</p></div>
      <label><span>Provider</span><input name="provider" required maxLength={120} defaultValue={readAnnouncementDraftValue(portal, "provider") || (isWater ? "Cagayan de Oro Water District (COWD)" : "CEPALCO")} onChange={() => setDraftSaved(false)} /></label>
      <div className="water-timeline-grid">
        <label><span>Scheduled start</span><input name="serviceStartsAt" type="datetime-local" value={serviceStartsAt} onChange={event => { setServiceStartsAt(event.target.value); setDraftSaved(false); }} /></label>
        <label><span>Estimated restoration</span><input name="estimatedRestorationAt" type="datetime-local" value={estimatedRestorationAt} onChange={event => { setEstimatedRestorationAt(event.target.value); setDraftSaved(false); }} /></label>
      </div>
    </section>
    <section className="water-form-card">
      <div className="water-section-heading"><div><h3>What residents need to know</h3><p>Explain what is happening and what residents should do.</p></div><small>{detailsLength} / 1800 characters</small></div>
      <label><span>Description</span><textarea name="details" required rows={6} maxLength={1800} defaultValue={readAnnouncementDraftValue(portal, "details")} onChange={event => { setDetailsLength(event.target.value.length); setDraftSaved(false); }} placeholder="Describe the service issue, affected customers, expected timing, and any safety guidance." /></label>
    </section>
    <section className="water-form-card">
      <div><h3>Show the location on a map (optional)</h3><p>Click the map to add a marker. You can skip this step.</p></div>
      <GoogleMap mode="picker" height={250} label="Select affected service location" selectedArea={selectedArea} selectedLocation={selectedLocation} onLocationSelected={setSelectedLocation} />
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">Enter map coordinates instead</summary>
        <div className="mt-3"><CoordinateInputs value={selectedLocation} onChange={setSelectedLocation} /></div>
      </details>
      <p aria-live="polite" className="water-selection-note">{selectedLocation ? "Map location selected. Click elsewhere on the map to change it." : "No map location selected. This is optional."}</p>
    </section>
    <section className="water-form-card">
      <div><h3>Notice image</h3><p>Add an image to include it with selected Facebook, Instagram, and Gmail delivery. Instagram always requires an image.</p></div>
      <AnnouncementImagePicker
        label="Images"
        helpText="Add up to 10 JPEG, PNG, or WebP images. Each is automatically optimized before publishing."
        labelClass=""
        onSelectionChange={() => setDraftSaved(false)}
      />
    </section>
    <section className="water-form-card">
      <div><h3>Where should we share this update?</h3><p>Choose one or more ways to share the announcement with residents and the community.</p></div>
      <div className="water-channel-list">
        {([
          ["gmail", "Email residents", "Email every registered resident with the announcement image."],
          ["facebook", "Facebook", "Publish every announcement to the connected utility page."],
          ["instagram", "Instagram", "Publish an image and caption to the connected account."],
        ] as const).map(([value, title, description]) => <label className="water-channel-row" key={value}>
          <span><strong>{title}</strong><small>{description}</small></span>
          <input type="checkbox" name="channels" value={value} checked={channels.includes(value)} onChange={() => toggleChannel(value)} />
        </label>)}
      </div>
      <SocialConnectionStatus portal={portal} token={token} />
      <GmailConnection portal={portal} token={token} />
    </section>
    <section className="water-form-card">
      <div><h3>Publish timing</h3><p>Publish when ready or set a future release time.</p></div>
      <label className="water-schedule-toggle"><input type="checkbox" checked={schedule} onChange={event => { setSchedule(event.target.checked); setDraftSaved(false); }} /> Schedule this advisory for later</label>
      {schedule && <label>Publish date and time<input name="scheduledAt" type="datetime-local" required min={minimumLocalDateTime()} defaultValue={readAnnouncementDraftValue(portal, "scheduledAt")} onChange={() => setDraftSaved(false)} /></label>}
      {!schedule && <input type="hidden" name="scheduledAt" value="" />}
    </section>
    <div className="water-publish-footer">{draftSaved && <span className="water-draft-saved" role="status">Draft saved in this browser.</span>}<button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={event => saveDraft(event.currentTarget.form)}>Save draft</button><button className="water-primary" type="submit" disabled={busy}>{busy ? "Publishing…" : schedule ? "Schedule advisory" : "Publish advisory"}</button></div>
  </form>;
}

function readAnnouncementDraftValue(portal: "water" | "cepalco", name: string) {
  return localStorage.getItem(`civicalert:${portal}:draft:${name}`) || "";
}

function readAnnouncementDraftChannels(portal: "water" | "cepalco"): string[] {
  const savedChannels = localStorage.getItem(`civicalert:${portal}:draft:channels`);
  if (savedChannels === null) return [...DEFAULT_ANNOUNCEMENT_CHANNELS];
  const channels = savedChannels.split("|");
  const selectedChannels = channels.filter(channel => ["gmail", "facebook", "instagram"].includes(channel));
  return selectedChannels.length ? selectedChannels : [...DEFAULT_ANNOUNCEMENT_CHANNELS];
}

function WorkTable({ items }: { items: WorkOrder[] }) {
  if (!items.length) return <Empty message={copy("copy_7fd74ce5eccf")} />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left"><thead><tr className="border-b border-slate-100 text-[9px] uppercase tracking-wide text-slate-400"><th className="px-2 py-2">{copy("copy_ce02285cc14e")}</th><th className="px-2 py-2">{copy("copy_024dc204d7ba")}</th><th className="px-2 py-2">{copy("copy_19734a1b58ca")}</th><th className="px-2 py-2">{copy("copy_920e413c7d41")}</th></tr></thead><tbody>{items.map(item => <tr key={item.id} className="border-b border-slate-50 text-[10px] text-slate-600 last:border-0"><td className="px-2 py-3"><strong className="block text-slate-800">{item.title}</strong><span className="text-[9px] text-slate-400">{item.reference}</span></td><td className="px-2 py-3">{item.area}</td><td className="px-2 py-3">{formatResidentDateTime(item.startsAt)}</td><td className="px-2 py-3"><span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-bold text-blue-800">{item.status}</span></td></tr>)}</tbody></table></div>;
}

function Network({ portal, advisories, network, errors }: { portal: Portal; advisories: Advisory[]; network: NetworkReading[]; errors: WorkspaceErrors }) {
  const water = portal === "water";
  return <div className="space-y-4">
    <article className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{water ? copy("copy_a057083f0c39") : copy("copy_10811357280f")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">Published notices with saved location coordinates.</p></div>
      {errors.advisories ? <SectionUnavailable title="Map locations" message={errors.advisories} /> : <GoogleMap mode="display" announcements={mapAnnouncements(advisories)} height={360} label={water ? "Water advisory locations" : "Utility advisory locations"} />}
    </article>
    {water && <PressureZones readings={network} unavailable={errors["network readings"]} />}
    <article className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4"><h2 className="m-0 text-base font-bold text-slate-900">{copy("copy_978de5ad70fd")}</h2><p className="mb-0 mt-1 text-[10px] text-slate-500">{copy("copy_bee37faf7a58")}</p></div><div className="grid gap-3 sm:grid-cols-2">{errors.advisories ? <SectionUnavailable title="Advisories" message={errors.advisories} /> : advisories.slice(0, 4).map(item => <DataCard key={item.id} item={item} page="incidents" />)}{!errors.advisories && advisories.length === 0 && <Empty message={copy("copy_f4aec847eb06")} />}</div></article>
  </div>;
}

function Services({ advisories, unavailable }: { advisories: Advisory[]; unavailable?: string }) {
  if (unavailable) return <SectionUnavailable title="Utility services" message={unavailable} />;
  const utilities = [...new Set(advisories.map(item => item.utility).filter(Boolean))].sort();
  return <div className="space-y-3">{utilities.length
    ? utilities.map(utility => {
      const activeCount = advisories.filter(item => item.utility === utility && !["Resolved", "Cancelled"].includes(item.status)).length;
      return <article key={utility} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5"><div><strong className="block text-sm text-slate-800">{utility}</strong><span className="text-[10px] text-slate-500">Based on utility announcements available to your account.</span></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-700">{activeCount ? `${activeCount} active notices` : "No active notices"}</span></article>;
    })
    : <Empty message="No utility announcement records are available yet." />}</div>;
}

function VirtualInbox({ messages, unavailable, onRead }: { messages: SMSRecord[]; unavailable?: string; onRead: (message: SMSRecord) => void }) {
  return <section className="space-y-3">
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{copy("smsInboxDisclaimer")}</p>
    {unavailable ? <SectionUnavailable title="Inbox" message={unavailable} /> : messages.length === 0 ? <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{copy("smsInboxEmpty")}</div> :
      messages.map(message => <article key={message.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-bold text-violet-800">{copy("smsInboxStatusSimulated")}</span><h2 className="mb-1 mt-3 text-sm font-bold text-slate-900">{message.utility} · {message.reference}</h2><SmsMessageText body={message.body} /></div>
          <div className="text-right"><span className={`text-[9px] font-bold ${message.read ? "text-slate-400" : "text-rose-700"}`}>{message.read ? copy("smsInboxStatusRead") : copy("smsInboxStatusUnread")}</span><p className="mt-2 text-[9px] text-slate-400">{message.recipient} · {message.phoneNumber}</p><time className="text-[9px] text-slate-400">{formatResidentDateTime(message.createdAt)}</time></div>
        </div>
        {!message.read && <button type="button" onClick={() => onRead(message)} className="mt-3 rounded-md border border-slate-200 px-3 py-1.5 text-[9px] font-semibold text-slate-600 hover:bg-slate-50">{copy("smsInboxMarkRead")}</button>}
      </article>)}
  </section>;
}

function SmsMessageText({ body }: { body: string }) {
  const parts = body.split(/(https:\/\/(?:www\.)?(?:facebook\.com|instagram\.com)\/[^\s]+)/g);
  return <p className="mb-0 whitespace-pre-line text-xs text-slate-600">{parts.map((part, index) =>
    /^https:\/\/(?:www\.)?(?:facebook\.com|instagram\.com)\//.test(part)
      ? <a key={index} href={part} target="_blank" rel="noreferrer" className="text-[var(--brand)] underline">{part}</a>
      : part,
  )}</p>;
}

function RecordModal({ portal, kind, onClose, onSubmit }: { portal: Portal; kind: "advisory" | "work"; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const water = portal === "water";
  const title = settingsFor(portal).modalTitles[kind];
  return <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-5 flex items-start justify-between"><div><p className="mb-2 text-[9px] font-extrabold tracking-[.15em] text-[var(--brand)]">{settingsFor(portal).label.toUpperCase()} {copy("copy_5493ff8e9397")}</p><h2 className="m-0 text-xl font-extrabold text-slate-900">{title}</h2></div><button onClick={onClose} className="rounded-lg bg-slate-100 p-2 text-slate-500" aria-label={copy("copy_7d9eb7acb13e")}><Icon name="close" /></button></div><form onSubmit={onSubmit} className="space-y-4">
    <label className="block text-xs font-bold text-slate-700">{kind === "work" ? copy("copy_713b2d01699a") : copy("copy_2b7f97151f81")}<input name="title" required placeholder={kind === "work" ? "Enter a work order title" : "Summarize the service update"} className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    <label className="block text-xs font-bold text-slate-700">{copy("copy_4dfc9891f0d9")}<ServiceAreaDropdown name="area" required className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    <label className="block text-xs font-bold text-slate-700">{kind === "work" ? copy("copy_7e4c74552701") : copy("copy_3d8e9e6f5e5f")}<textarea name={kind === "work" ? "description" : "details"} required rows={4} placeholder={copy("copy_ef9e65b78190")} className="mt-2 block w-full rounded-lg border border-slate-200 p-3 text-sm font-normal" /></label>
    {kind === "work" && <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-bold text-slate-700">{copy("copy_e4bb9f1ece9a")}<input name="startsAt" type="datetime-local" required className="mt-2 block w-full rounded-lg border border-slate-200 p-2.5 text-xs font-normal" /></label><label className="block text-xs font-bold text-slate-700">{copy("copy_f4db1e48476f")}<input name="endsAt" type="datetime-local" required className="mt-2 block w-full rounded-lg border border-slate-200 p-2.5 text-xs font-normal" /></label></div>}
    <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600">{copy("copy_19766ed6ccb2")}</button><button className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-xs font-bold text-white">{kind === "advisory" ? copy("copy_3e2f45d85a26") : copy("copy_a6de1b1266b1")}</button></div>
  </form></section></div>;
}

function PortalApp({ portal }: { portal: Portal }) {
  return <App portal={portal} />;
}

class PortalErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Portal rendering failed.", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <main className="min-h-screen p-6 text-slate-900">
        <section role="alert" className="mx-auto mt-10 max-w-xl rounded-xl border border-rose-300 bg-rose-50 p-5">
          <h1 className="m-0 text-lg font-bold">The portal could not be displayed.</h1>
          <p className="mt-2 text-sm">{this.state.error.message}</p>
          <button type="button" onClick={() => location.reload()} className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Reload portal
          </button>
        </section>
      </main>;
    }
    return this.props.children;
  }
}

export function mountPortal(portal: Portal) {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root mount element");
  const root = createRoot(element);
  root.render(<main role="status">Loading portal configuration...</main>);
  try {
    void (async () => {
      try {
        const response = await fetch(`${apiBaseUrl(portal)}/content`);
        const content: unknown = await response.json();
        if (!response.ok) {
          const message = content && typeof content === "object" && "error" in content && typeof content.error === "string"
            ? content.error
            : `Could not load portal configuration (HTTP ${response.status}).`;
          throw new Error(message);
        }
        if (!isPortalContent(content)) throw new Error("The API returned invalid portal configuration.");
        portalContent = content;
        getSupabase();
        root.render(<PortalErrorBoundary><PortalApp portal={portal} /></PortalErrorBoundary>);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not initialize the portal.";
        root.render(<main role="alert">{message}</main>);
      }
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not initialize the portal.";
    root.render(<main role="alert">{message}</main>);
  }
}

function isPortalContent(value: unknown): value is PortalContent {
  if (!value || typeof value !== "object") return false;
  const content = value as Record<string, unknown>;
  if (!content.copy || typeof content.copy !== "object" || !content.settings || typeof content.settings !== "object") return false;
  const copyEntries = Object.values(content.copy);
  if (!copyEntries.every(entry => typeof entry === "string")) return false;
  const settings = content.settings as Record<string, unknown>;
  return (["resident", "cepalco", "water"] as const).every(portal => {
    const setting = settings[portal];
    if (!setting || typeof setting !== "object") return false;
    const record = setting as Record<string, unknown>;
    return typeof record.label === "string" &&
      typeof record.brand === "string" &&
      Array.isArray(record.navigation) &&
      !!record.pageTitles && typeof record.pageTitles === "object" &&
      !!record.pageDescriptions && typeof record.pageDescriptions === "object" &&
      !!record.modalTitles && typeof record.modalTitles === "object";
  });
}
