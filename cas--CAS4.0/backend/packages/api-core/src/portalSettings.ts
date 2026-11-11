export type PortalSettings = {
  label: string;
  brand: string;
  color: string;
  navigation: Array<{ key: string; label: string; icon: string }>;
  pageTitles: Record<string, string>;
  pageDescriptions: Record<string, string>;
  sidebarLabel: string;
  pageHeadingLabel: string;
  publishButtonLabel?: string;
  overviewGreetingPrefix?: string;
  modalTitles: Record<"advisory" | "work", string>;
  barangays?: string[];
  districts?: string[];
  locationDefaults?: { city: string; postalCode: string };
  publicNavigation?: string[];
  registerHighlights?: Array<{ icon: string; title: string; detail: string }>;
  filters?: Record<string, string[]>;
  categories?: Array<{ value: string; description: string; icon?: string }>;
  priorities?: string[];
  services?: Array<{ name: string; description: string; icon: string; advisoryStatus: string; operationalStatus: string }>;
  dashboard?: Record<string, string | number>;
  metrics?: Array<{ key: string; label: string; icon: string; value?: string; badge?: string }>;
  mapMetrics?: Array<{ key: string; label: string; value?: string; detail: string; icon: string }>;
  scheduleMetrics?: Array<{ key: string; label: string; value: string; detail: string; icon: string }>;
  networkStatus?: { pressureWatchThresholdPsi: number; watch: string; normal: string };
  maps?: Record<string, Array<{ kind: string; left: number; top: number }>>;
  mapLabels?: Record<string, string>;
};

export const portalSettings = {
  resident: {
    label: "Resident",
    brand: "Community Alert System (CAS)",
    color: "red",
    navigation: [
      { key: "overview", label: "Dashboard", icon: "home" },
      { key: "inbox", label: "Notifications", icon: "messages" },
      { key: "services", label: "Map View", icon: "map" },
      { key: "about", label: "About", icon: "info" },
      { key: "profile", label: "Settings", icon: "settings" },
    ],
    pageTitles: {
      overview: "My community",
      advisories: "Local service updates",
      inbox: "My alerts",
      services: "Power & water status",
      about: "About Community Alert System",
      profile: "My profile",
    },
    pageDescriptions: {
      overview: "Your service area status and latest verified community updates.",
      advisories: "The latest power and water service updates for your area.",
      inbox: "See alerts sent to your account here. These are in-app messages; no text messages are sent to your phone.",
      services: "Check the current service status for your utility providers.",
      about: "Learn how the Community Alert System keeps Cagayan de Oro residents informed.",
      profile: "Manage your contact details and service location. Utility announcements are sent to all residents.",
    },
    sidebarLabel: "RESIDENT SERVICES",
    pageHeadingLabel: "RESIDENT PORTAL · CAGAYAN DE ORO CITY",
    publishButtonLabel: "Publish advisory",
    overviewGreetingPrefix: "Good day,",
    modalTitles: { advisory: "Publish service advisory", work: "Create work order" },
    publicNavigation: ["Advisories", "Services", "Directory", "Support"],
    registerHighlights: [
      { icon: "shield", title: "Service Interruption Updates", detail: "Local power and water service advisories for your area." },
      { icon: "messages", title: "Resident Inbox Alerts", detail: "Simulated announcement alerts appear in every resident's inbox; no SMS text is sent." },
      { icon: "map", title: "Community Updates", detail: "Receive utility announcements sent to all residents." },
    ],
    barangays: ["Agusan", "Balulang", "Bugo", "Carmen", "Gusa", "Iponan", "Kauswagan", "Lumbia", "Macabalan", "Macasandig", "Nazareth", "Patag", "Puerto"],
    districts: ["1st District", "2nd District"],
    locationDefaults: { city: "Cagayan de Oro City", postalCode: "9000" },
    filters: {
      utilities: ["All", "CEPALCO", "Water District"],
      advisoryStatuses: ["All", "Monitoring", "Under investigation", "Crew dispatched", "Resolved"],
      quickFilters: ["All", "CEPALCO", "Water District", "Crew dispatched", "Under investigation", "Resolved"],
    },
    services: [
      { name: "CEPALCO", description: "Electric power services", icon: "pulse", advisoryStatus: "Advisory in area", operationalStatus: "Operational" },
      { name: "Water District", description: "Water supply and distribution", icon: "water", advisoryStatus: "Advisory in area", operationalStatus: "Operational" },
    ],
    dashboard: { connectedServices: 2, updateFrequency: "24/7", communityProviders: 2 },
    metrics: [
      { key: "activeAdvisories", label: "Active local advisories", icon: "alert", badge: "Attention required" },
      { key: "connectedServices", label: "Connected utility services", icon: "water", value: "2", badge: "Power & Water" },
      { key: "updateFrequency", label: "Verified service updates", icon: "pulse", value: "24/7", badge: "Live feed" },
    ],
    maps: {
      community: [
        { kind: "power", left: 38, top: 51 },
        { kind: "water", left: 65, top: 39 },
        { kind: "planned", left: 76, top: 69 },
      ],
      mini: [
        { kind: "service", left: 63, top: 48 },
        { kind: "planned", left: 36, top: 28 },
        { kind: "report", left: 77, top: 72 },
      ],
    },
    mapLabels: { community: "CAGAYAN DE ORO · SERVICE ZONES", mini: "CAGAYAN DE ORO" },
  },
  cepalco: {
    label: "CEPALCO",
    brand: "CEPALCO Operations",
    color: "red",
    navigation: [
      { key: "overview", label: "Overview", icon: "home" },
      { key: "incidents", label: "Active disruptions", icon: "alert" },
      { key: "residents", label: "Resident reports", icon: "messages" },
    ],
    pageTitles: {
      overview: "Operations overview",
      incidents: "Active disruptions",
      residents: "Resident reports",
      publish: "Create announcement",
    },
    pageDescriptions: {
      overview: "Your service area status and latest verified community updates.",
      incidents: "Review current power interruptions and their status.",
      residents: "Review service reports submitted by residents.",
      publish: "Write a clear service update, choose where to share it, and publish now or schedule it.",
    },
    sidebarLabel: "CEPALCO OPERATIONS",
    pageHeadingLabel: "CEPALCO OPERATIONS",
    publishButtonLabel: "Create announcement",
    modalTitles: { advisory: "Publish service advisory", work: "Create work order" },
    filters: {
      incidentStatuses: ["All", "Monitoring", "Under investigation", "Crew dispatched", "Resolved"],
    },
    metrics: [
      { key: "activeDisruptions", label: "Active disruptions", icon: "alert" },
    ],
    categories: [
      { value: "Unplanned outage", description: "Power stopped unexpectedly" },
      { value: "Voltage issue", description: "Unusual or unstable power" },
      { value: "Planned maintenance", description: "Scheduled electrical service work" },
      { value: "Safety alert", description: "Important electrical safety information" },
    ],
    priorities: ["Critical", "High", "Normal"],
  },
  water: {
    label: "Water District",
    brand: "Water District",
    color: "blue",
    networkStatus: { pressureWatchThresholdPsi: 35, watch: "Watch", normal: "Normal" },
    navigation: [
      { key: "overview", label: "Overview", icon: "home" },
      { key: "incidents", label: "Water advisories", icon: "alert" },
      { key: "residents", label: "Resident reports", icon: "messages" },
      { key: "restoration", label: "Network map", icon: "map" },
    ],
    pageTitles: {
      overview: "Water service overview",
      incidents: "Water service advisories",
      scheduled: "Water maintenance schedule",
      restoration: "Water network map",
      residents: "Water service reports",
      publish: "Create announcement",
    },
    pageDescriptions: {
      overview: "Monitor water quality, pressure, advisories, and maintenance across the district.",
      incidents: "Review current water service interruptions and their status.",
      scheduled: "Plan and track upcoming service work.",
      restoration: "Review local service activity by district.",
      residents: "Review service reports submitted by residents.",
      publish: "Write a clear service update, choose where to share it, and publish now or schedule it.",
    },
    sidebarLabel: "WATER DISTRICT OPERATIONS",
    pageHeadingLabel: "WATER DISTRICT OPERATIONS",
    publishButtonLabel: "Create announcement",
    modalTitles: { advisory: "Publish water advisory", work: "Schedule water maintenance" },
    filters: {
      reportUtilities: ["All", "CEPALCO", "Water District"],
      reportStatuses: ["All", "Crew dispatched", "Under investigation", "Resolved"],
      workStatuses: ["All scheduled", "Scheduled"],
    },
    categories: [
      { value: "Emergency interruption", description: "Unexpected loss of water service" },
      { value: "Low pressure notice", description: "Water pressure is lower than usual" },
      { value: "Under investigation", description: "Our team is checking the problem" },
      { value: "Urgent alert", description: "Important information residents need now" },
      { value: "Scheduled work", description: "Planned water service work" },
      { value: "Boil water alert", description: "Important water safety guidance" },
      { value: "Scheduled maintenance", description: "Planned water system maintenance" },
      { value: "Resolved", description: "Water service is back to normal" },
    ],
    priorities: ["Emergency", "Urgent", "High", "Normal"],
    dashboard: { reservoirStatus: "3 online" },
    metrics: [
      { key: "activeAdvisories", label: "Active water advisories", icon: "water" },
      { key: "averagePressure", label: "Average network pressure", icon: "pulse" },
      { key: "scheduledMaintenance", label: "Scheduled maintenance", icon: "calendar" },
      { key: "residentReports", label: "Resident service reports", icon: "people" },
    ],
    maps: {
      mini: [
        { kind: "service", left: 63, top: 48 },
        { kind: "planned", left: 36, top: 28 },
        { kind: "report", left: 77, top: 72 },
      ],
      network: [
        { kind: "service", left: 56, top: 42 },
        { kind: "planned", left: 32, top: 25 },
        { kind: "report", left: 72, top: 68 },
        { kind: "report", left: 24, top: 72 },
      ],
    },
    mapLabels: { mini: "WATER SERVICE DISTRICTS", network: "WATER SERVICE DISTRICTS" },
  },
} satisfies Record<"resident" | "cepalco" | "water", PortalSettings>;
