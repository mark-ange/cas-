import { PrismaClient, Role, ServiceType } from "@prisma/client";
import { hashPassword } from "../src/utils/password.js";
import config from "../src/config/index.js";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("🌱 Starting seed...");

  // =========================================================================
  // BARANGAYS & PUROKS (Cagayan de Oro City pilot areas)
  // =========================================================================

  const barangaysData = [
    {
      name: "Barangay 1",
      puroks: ["Purok 1", "Purok 2", "Purok 3", "Purok 4"],
    },
    {
      name: "Barangay 2",
      puroks: ["Purok 1", "Purok 2", "Purok 3"],
    },
    {
      name: "Barangay 3",
      puroks: ["Purok 1", "Purok 2"],
    },
  ];

  for (const bgData of barangaysData) {
    const barangay = await prisma.barangay.upsert({
      where: { name: bgData.name },
      update: { name: bgData.name },
      create: {
        name: bgData.name,
        city: "Cagayan de Oro City",
        active: true,
        puroks: {
          create: bgData.puroks.map((name) => ({ name, active: true })),
        },
      },
    });
    console.log(`✓ Created/updated barangay: ${barangay.name} (${barangay.id})`);
  }

  // =========================================================================
  // ADMIN USER
  // =========================================================================

  const adminPassword = config.initialAdminPassword;
  const adminHash = await hashPassword(adminPassword);

  const admin = await prisma.user.upsert({
    where: { email: config.initialAdminEmail },
    update: {
      active: true,
      passwordHash: adminHash,
    },
    create: {
      email: config.initialAdminEmail,
      passwordHash: adminHash,
      role: Role.ADMIN,
      fullName: "System Administrator",
      phone: "+639123456789",
      active: true,
      privacyConsent: true,
      privacyConsentAt: new Date(),
    },
  });

  console.log(`✓ Admin user ready: ${admin.email}`);
  console.log(`  Password: ${adminPassword}`);

  // =========================================================================
  // WATER & POWER DISPATCHERS
  // =========================================================================

  const dispatchersData = [
    {
      email: "water.dispatcher@cas.local",
      fullName: "Juan Dela Cruz",
      serviceType: ServiceType.WATER,
      role: Role.WATER_DISPATCHER,
    },
    {
      email: "power.dispatcher@cas.local",
      fullName: "Maria Santos",
      serviceType: ServiceType.POWER,
      role: Role.POWER_DISPATCHER,
    },
  ];

  for (const d of dispatchersData) {
    const hash = await hashPassword("DispatcherPass!2024");
    const user = await prisma.user.upsert({
      where: { email: d.email },
      update: { active: true, role: d.role },
      create: {
        email: d.email,
        passwordHash: hash,
        role: d.role,
        fullName: d.fullName,
        phone: "+639123456789",
        active: true,
        privacyConsent: true,
        privacyConsentAt: new Date(),
        dispatcherProfile: {
          create: { serviceType: d.serviceType },
        },
      },
    });
    console.log(`✓ Dispatcher created: ${user.email} (${d.serviceType})`);
  }

  // =========================================================================
  // SAMPLE RESIDENTS
  // =========================================================================

  const barangays = await prisma.barangay.findMany({
    include: { puroks: true },
  });

  const sampleResidents = [
    {
      email: "resident1@cas.local",
      fullName: "Alice Robles",
      phone: "+639171234567",
      password: "ResidentPass123!",
    },
    {
      email: "resident2@cas.local",
      fullName: "Bob Lee",
      phone: "+639182345678",
      password: "ResidentPass123!",
    },
    {
      email: "resident3@cas.local",
      fullName: "Charlie Tan",
      phone: "+639193456789",
      password: "ResidentPass123!",
    },
  ];

    const bg1 = barangays[0]!;
  const bg2 = barangays[1]!;

  for (let i = 0; i < sampleResidents.length; i++) {
    const r = sampleResidents[i]!;
    const hash = await hashPassword(r.password);
    const barangay = i === 0 ? bg1 : i === 1 ? bg1 : bg2;
    const purok = barangay.puroks[i % barangay.puroks.length]!;

    const user = await prisma.user.upsert({
      where: { email: r.email },
      update: { active: true },
      create: {
        email: r.email,
        passwordHash: hash,
        role: Role.RESIDENT,
        fullName: r.fullName,
        phone: r.phone,
        active: true,
        privacyConsent: true,
        privacyConsentAt: new Date(),
        residentProfile: {
          create: {
            barangayId: barangay.id,
            purokId: purok.id,
            waterOptIn: true,
            powerOptIn: true,
          },
        },
      },
    });
    console.log(`✓ Resident created: ${user.email} (${barangay.name}, ${purok.name})`);
  }

  console.log("\n🎉 Seed complete!");
  console.log("\n📋 Test credentials:");
  console.log(`   Admin:      ${config.initialAdminEmail} / ${adminPassword}`);
  console.log("   Dispatcher: water.dispatcher@cas.local / DispatcherPass!2024");
  console.log("   Dispatcher: power.dispatcher@cas.local / DispatcherPass!2024");
  console.log("   Resident:   resident1@cas.local / ResidentPass123!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
