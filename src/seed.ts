import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ✅ New hierarchy settings
const ROOT_LEVEL = 3;   // max level is 3
const LEAF_LEVEL = 1;   // lowest level
const BRANCHING = 3;    // exactly 3 children
const TEAM_ROOTS = 3;   // ✅ number of separate teams (change this)

// Unique phone generator for seeded users
let phoneCounter = 20000;
function nextPhone() {
  phoneCounter += 1;
  return `+9000001${phoneCounter.toString().padStart(5, "0")}`;
}

function makeName(teamIndex: number, level: number, path: number[]) {
  // example: Team 2 • L1 Rep 2.1.3
  return `Team ${teamIndex} • L${level} Rep ${path.join(".")}`;
}

async function createUser(params: {
  fullName: string;
  phoneE164?: string;
  password: string;
  role?: "ADMIN" | "AUTHORITY" | "USER";
  level: number;
  leaderId?: string | null;
}) {
  const phoneE164 = params.phoneE164 ?? nextPhone();

  return prisma.user.create({
    data: {
      fullName: params.fullName,
      phoneE164,
      password: params.password,
      role: params.role ?? "USER",
      level: params.level,
      leaderId: params.leaderId ?? null,
      isActive: true,
      avatarUrl: null,
      lastSeenAt: null,
    },
    select: { id: true, fullName: true, phoneE164: true, level: true },
  });
}

// Create subtree: parent at level L gets 3 children at level L-1 until LEAF_LEVEL
async function createSubtree(params: {
  teamIndex: number;
  parentId: string;
  parentLevel: number;
  path: number[];
}) {
  const { teamIndex, parentId, parentLevel, path } = params;

  if (parentLevel <= LEAF_LEVEL) return;

  const childLevel = parentLevel - 1;

  for (let i = 1; i <= BRANCHING; i++) {
    const childPath = [...path, i];

    const child = await createUser({
      fullName: makeName(teamIndex, childLevel, childPath),
      password: "pass",
      level: childLevel,
      leaderId: parentId,
    });

    await createSubtree({
      teamIndex,
      parentId: child.id,
      parentLevel: childLevel,
      path: childPath,
    });
  }
}

async function main() {
  // DEV wipe (clean)
  await prisma.presentation.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.user.deleteMany();

  // Admin + Authority
  await createUser({
    fullName: "Admin",
    phoneE164: "+900000000001",
    password: "admin",
    role: "ADMIN",
    level: 10,
    leaderId: null,
  });

  await createUser({
    fullName: "Authority",
    phoneE164: "+900000000002",
    password: "authority",
    role: "AUTHORITY",
    level: 10,
    leaderId: null,
  });

  // ✅ Create multiple Level-3 team roots
  const roots: Array<{ id: string; phoneE164: string; fullName: string }> = [];

  for (let t = 1; t <= TEAM_ROOTS; t++) {
    const rootPhone = t === 1 ? "+900000000003" : nextPhone(); // keep first predictable
    const root = await createUser({
      fullName: `Team ${t} • Leader L3`,
      phoneE164: rootPhone,
      password: t === 1 ? "leader" : "pass",
      role: "USER",
      level: ROOT_LEVEL,
      leaderId: null,
    });

    roots.push({ id: root.id, phoneE164: root.phoneE164, fullName: root.fullName });

    // subtree under each root
    await createSubtree({
      teamIndex: t,
      parentId: root.id,
      parentLevel: ROOT_LEVEL,
      path: [t], // start path with team index
    });
  }

  // Customer (one shared)
  const customer = await prisma.customer.create({
    data: {
      fullName: "Test Customer",
      phoneE164: "+905555555555",
    },
    select: { id: true },
  });

  // Pick one Level 1 salesperson from any team to attach a sample contract
  const oneSalesperson = await prisma.user.findFirst({
    where: { level: 1, leaderId: { not: null } },
    select: { id: true },
  });

  if (oneSalesperson) {
    await prisma.contract.create({
      data: {
        status: "CUSTOMER_CONFIRM_PENDING",

        customerId: customer.id,
        salespersonId: oneSalesperson.id,

        unitType: "STUDIO",
        weekOfYear: 12,
        paymentPlan: "ALTIN",
        priceCents: 2500000,

        presentationId: null,
        approvedById: null,

        customerOtpHash: null,
        customerOtpSentAt: null,
        customerConfirmedAt: null,

        rejectedReason: null,
      } as any,
    });
  }

  console.log("✅ Seed complete (max level 3 + multiple teams).");
  console.log("Logins:");
  console.log("ADMIN     +900000000001 / admin");
  console.log("AUTHORITY +900000000002 / authority");
  console.log("TEAM 1 L3 " + roots[0].phoneE164 + " / leader");
  console.log("Other roots / users password: pass");
  console.log("Teams created:", TEAM_ROOTS);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });