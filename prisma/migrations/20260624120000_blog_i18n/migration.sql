-- CreateTable
CREATE TABLE "BlogPostTranslation" (
    "id" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "postId" TEXT NOT NULL,

    CONSTRAINT "BlogPostTranslation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BlogPostTranslation" ADD CONSTRAINT "BlogPostTranslation_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateUniqueIndex
CREATE UNIQUE INDEX "BlogPostTranslation_postId_locale_key" ON "BlogPostTranslation"("postId", "locale");

-- MigrateData: copy existing Turkish content into translations table
INSERT INTO "BlogPostTranslation" ("id", "locale", "title", "excerpt", "content", "category", "postId")
SELECT gen_random_uuid()::text, 'tr', "title", "excerpt", "content", "category", "id"
FROM "BlogPost";

-- AlterTable: remove translatable columns from BlogPost
ALTER TABLE "BlogPost" DROP COLUMN "title";
ALTER TABLE "BlogPost" DROP COLUMN "excerpt";
ALTER TABLE "BlogPost" DROP COLUMN "content";
ALTER TABLE "BlogPost" DROP COLUMN "category";
