import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

type Args = {
  fullName: string;
  phoneE164: string;
  password: string;
  role: Role;
  level: number;
};

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseArgs(): Args {
  const fullName = getArg("--fullName") ?? process.env.ADMIN_FULL_NAME;
  const phoneE164 = getArg("--phone") ?? process.env.ADMIN_PHONE;
  const password = getArg("--password") ?? process.env.ADMIN_PASSWORD;
  const roleRaw = (getArg("--role") ?? process.env.ADMIN_ROLE ?? "ADMIN").toUpperCase();
  const levelRaw = getArg("--level") ?? process.env.ADMIN_LEVEL ?? "10";

  if (!fullName) throw new Error("Missing full name. Use --fullName or ADMIN_FULL_NAME.");
  if (!phoneE164) throw new Error("Missing phone. Use --phone or ADMIN_PHONE.");
  if (!password) throw new Error("Missing password. Use --password or ADMIN_PASSWORD.");
  if (!/^\+\d{10,15}$/.test(phoneE164)) {
    throw new Error("phone must be E.164 format, example: +905551112233");
  }

  const roleValues = new Set<Role>(["ADMIN", "REGIONAL_MANAGER", "REGIONAL_LEADER", "AUTHORITY", "USER"]);
  if (!roleValues.has(roleRaw as Role)) {
    throw new Error("Invalid role. Allowed: ADMIN, REGIONAL_MANAGER, REGIONAL_LEADER, AUTHORITY, USER");
  }

  const level = Number(levelRaw);
  if (!Number.isFinite(level) || level < 0) {
    throw new Error("level must be a non-negative number");
  }

  return {
    fullName,
    phoneE164,
    password,
    role: roleRaw as Role,
    level,
  };
}

async function main() {
  const args = parseArgs();

  const exists = await prisma.user.findUnique({ where: { phoneE164: args.phoneE164 } });
  if (exists) {
    console.log(`User already exists for ${args.phoneE164} (id=${exists.id}).`);
    return;
  }

  const created = await prisma.user.create({
    data: {
      fullName: args.fullName,
      phoneE164: args.phoneE164,
      password: args.password,
      role: args.role,
      level: args.level,
      isActive: true,
      leaderId: null,
    },
    select: {
      id: true,
      fullName: true,
      phoneE164: true,
      role: true,
      level: true,
      createdAt: true,
    },
  });

  console.log("Admin/user created:");
  console.log(created);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
