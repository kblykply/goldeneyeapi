import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { IsOptional, IsString } from "class-validator";
import { Request } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamService } from "../team/team.service";
import { AuthedUser } from "../auth/auth.types";
import { AuditService } from "../audit/audit.service";

class CreateNoteDto {
  @IsString()
  body!: string;
}

class UpdateCustomerDto {
  @IsString()
  @IsOptional()
  fullName?: string;

  @IsString()
  @IsOptional()
  phoneE164?: string;
}

@Controller("customers")
export class CustomersController {
  constructor(
    private prisma: PrismaService,
    private team: TeamService,
    private audit: AuditService,
  ) {}

  private async assertAccess(customerId: string, me: AuthedUser): Promise<void> {
    if (me.role === "ADMIN") return;
    const ids = await this.team.getSubtreeIds(me.id);
    const exists = await this.prisma.presentation.findFirst({
      where: { customerId, salespersonId: { in: [...ids] } },
      select: { id: true },
    });
    if (!exists) throw new ForbiddenException("Yetkisiz");
  }

  /**
   * GET /customers
   * ADMIN → tüm müşteriler; diğerleri → subtree'deki salesperson'ların müşterileri
   */
  @Get()
  async list(
    @Req() req: Request & { user: AuthedUser },
    @Query("search") search?: string,
  ) {
    const me = req.user;

    let where: Prisma.CustomerWhereInput = search
      ? {
          OR: [
            { fullName: { contains: search, mode: "insensitive" } },
            { phoneE164: { contains: search } },
          ],
        }
      : {};

    if (me.role !== "ADMIN") {
      const ids = await this.team.getSubtreeIds(me.id);
      where = {
        ...where,
        presentations: { some: { salespersonId: { in: [...ids] } } },
      };
    }

    const items = await this.prisma.customer.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        fullName: true,
        phoneE164: true,
        _count: { select: { presentations: true, contracts: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return { ok: true, items };
  }

  /**
   * GET /customers/:id
   * Tek sorguda: sunumlar + sözleşmeler + notlar
   */
  @Get(":id")
  async detail(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser },
  ) {
    const me = req.user;

    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        presentations: {
          select: {
            id: true,
            createdAt: true,
            status: true,
            unitType: true,
            weekOfYear: true,
            endedAt: true,
            salesperson: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        contracts: {
          select: {
            id: true,
            createdAt: true,
            status: true,
            unitType: true,
            weekOfYear: true,
            paymentPlan: true,
            basePriceCents: true,
            salesperson: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        notes: {
          select: {
            id: true,
            createdAt: true,
            body: true,
            author: { select: { id: true, fullName: true, role: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    });

    if (!customer) return { ok: false, message: "Müşteri bulunamadı" };

    if (me.role !== "ADMIN") {
      const ids = await this.team.getSubtreeIds(me.id);
      const hasAccess = customer.presentations.some((p) => ids.has(p.salesperson.id));
      if (!hasAccess) return { ok: false, message: "Yetkisiz" };
    }

    return { ok: true, customer };
  }

  /**
   * PATCH /customers/:id
   * İsim / telefon güncelle
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: UpdateCustomerDto,
    @Req() req: Request & { user: AuthedUser },
  ) {
    await this.assertAccess(id, req.user);

    const data: Prisma.CustomerUpdateInput = {};
    if (body.fullName !== undefined) data.fullName = body.fullName;
    if (body.phoneE164 !== undefined) data.phoneE164 = body.phoneE164;

    const customer = await this.prisma.customer.update({
      where: { id },
      data,
      select: { id: true, fullName: true, phoneE164: true },
    });

    await this.audit.log({
      action: 'CUSTOMER_UPDATED',
      entityType: 'CUSTOMER',
      entityId: id,
      meta: { fields: Object.keys(data) },
    });

    return { ok: true, customer };
  }

  /**
   * DELETE /customers/:id
   * Sadece ADMIN silebilir
   */
  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @Req() req: Request & { user: AuthedUser },
  ) {
    if (req.user.role !== "ADMIN") return { ok: false, message: "Yetkisiz" };

    await this.prisma.customerNote.deleteMany({ where: { customerId: id } });
    await this.prisma.customer.delete({ where: { id } });

    await this.audit.log({
      action: 'CUSTOMER_DELETED',
      entityType: 'CUSTOMER',
      entityId: id,
    });

    return { ok: true };
  }

  /**
   * POST /customers/:id/notes
   * Müşteriye not ekle
   */
  @Post(":id/notes")
  async addNote(
    @Param("id") id: string,
    @Body() body: CreateNoteDto,
    @Req() req: Request & { user: AuthedUser },
  ) {
    await this.assertAccess(id, req.user);

    const note = await this.prisma.customerNote.create({
      data: { customerId: id, authorId: req.user.id, body: body.body },
      select: {
        id: true,
        createdAt: true,
        body: true,
        author: { select: { id: true, fullName: true, role: true } },
      },
    });

    await this.audit.log({
      action: 'CUSTOMER_NOTE_ADDED',
      entityType: 'CUSTOMER',
      entityId: id,
      meta: { noteId: note.id },
    });

    return { ok: true, note };
  }

  /**
   * DELETE /customers/:id/notes/:noteId
   * Notu yazan kullanıcı veya ADMIN silebilir
   */
  @Delete(":id/notes/:noteId")
  async deleteNote(
    @Param("id") id: string,
    @Param("noteId") noteId: string,
    @Req() req: Request & { user: AuthedUser },
  ) {
    const note = await this.prisma.customerNote.findUnique({
      where: { id: noteId },
    });

    if (!note || note.customerId !== id) {
      return { ok: false, message: "Not bulunamadı" };
    }

    if (req.user.role !== "ADMIN" && note.authorId !== req.user.id) {
      return { ok: false, message: "Yetkisiz" };
    }

    await this.prisma.customerNote.delete({ where: { id: noteId } });

    await this.audit.log({
      action: 'CUSTOMER_NOTE_DELETED',
      entityType: 'CUSTOMER',
      entityId: id,
      meta: { noteId },
    });

    return { ok: true };
  }
}
