-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretField" TEXT,
    "testDate" TIMESTAMPTZ(6),
    "status" TEXT,
    "role" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "profileId" TEXT,
    "referredById" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "authorId" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "modelType" TEXT NOT NULL,
    "status" TEXT,
    "timeControl" TEXT,
    "rated" BOOLEAN,
    "resort" TEXT,
    "skillLevel" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "inviterId" TEXT,
    "opponentId" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chessMatchs" (
    "id" TEXT NOT NULL,
    "timeControl" TEXT NOT NULL,
    "rated" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "inviterId" TEXT,

    CONSTRAINT "chessMatchs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skiMatchs" (
    "id" TEXT NOT NULL,
    "resort" TEXT NOT NULL,
    "skillLevel" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "inviterId" TEXT,

    CONSTRAINT "skiMatchs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "containerId" TEXT,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "priceAmount" DOUBLE PRECISION,
    "priceCurrency" TEXT,
    "minBidAmount" DOUBLE PRECISION,
    "minBidCurrency" TEXT,
    "slotStartHour" DOUBLE PRECISION,
    "slotStartMinute" DOUBLE PRECISION,
    "slotEndHour" DOUBLE PRECISION,
    "slotEndMinute" DOUBLE PRECISION,
    "flexPriceAmount" DOUBLE PRECISION,
    "flexPriceDiscount" DOUBLE PRECISION,
    "tags" JSONB,
    "schedule" JSONB,
    "slug" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validatingListings" (
    "id" TEXT NOT NULL,
    "priceAmount" DOUBLE PRECISION,
    "priceCurrency" TEXT,
    "slotStartHour" DOUBLE PRECISION,
    "slotStartMinute" DOUBLE PRECISION,
    "slotEndHour" DOUBLE PRECISION,
    "slotEndMinute" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "validatingListings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remappedListings" (
    "id" TEXT NOT NULL,
    "priceCents" DOUBLE PRECISION NOT NULL,
    "priceCurrency" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "remappedListings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "scheduledFor" TIMESTAMPTZ(6) NOT NULL,
    "day" TIMESTAMPTZ(6),
    "startTime" TIMESTAMPTZ(6),
    "localStart" TIMESTAMPTZ(6),
    "billingMonth" TIMESTAMPTZ(6),
    "anniversary" TIMESTAMPTZ(6),
    "zonedStartInstant" TIMESTAMPTZ(6),
    "zonedStartZone" TEXT,
    "duration" TEXT,
    "vacationFrom" TIMESTAMPTZ(6),
    "vacationTo" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "creatorId" TEXT,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roomMembers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "roomId" TEXT,

    CONSTRAINT "roomMembers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roomMessages" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "roomId" TEXT,

    CONSTRAINT "roomMessages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "tick" INTEGER,
    "authorId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "loggedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changes" (
    "transactionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT,
    "values" JSONB,
    "links" JSONB,
    "targetIds" JSONB,

    CONSTRAINT "changes_pkey" PRIMARY KEY ("transactionId","position")
);

-- CreateTable
CREATE TABLE "bucketLog" (
    "bucket" TEXT NOT NULL,
    "tick" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL,

    CONSTRAINT "bucketLog_pkey" PRIMARY KEY ("bucket","tick","entity","entityId")
);

-- CreateTable
CREATE TABLE "changeFeedPosition" (
    "slot" TEXT NOT NULL,
    "lsn" TEXT NOT NULL,

    CONSTRAINT "changeFeedPosition_pkey" PRIMARY KEY ("slot")
);

-- CreateTable
CREATE TABLE "_postsTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_postsTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_profileId_key" ON "users"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_opponentId_key" ON "invitations"("opponentId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_tick_key" ON "transactions"("tick");

-- CreateIndex
CREATE INDEX "changes_entity_entityId_idx" ON "changes"("entity", "entityId");

-- CreateIndex
CREATE INDEX "bucketLog_entity_tick_idx" ON "bucketLog"("entity", "tick");

-- CreateIndex
CREATE INDEX "_postsTags_B_index" ON "_postsTags"("B");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_opponentId_fkey" FOREIGN KEY ("opponentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chessMatchs" ADD CONSTRAINT "chessMatchs_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skiMatchs" ADD CONSTRAINT "skiMatchs_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roomMembers" ADD CONSTRAINT "roomMembers_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roomMessages" ADD CONSTRAINT "roomMessages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changes" ADD CONSTRAINT "changes_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_postsTags" ADD CONSTRAINT "_postsTags_A_fkey" FOREIGN KEY ("A") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_postsTags" ADD CONSTRAINT "_postsTags_B_fkey" FOREIGN KEY ("B") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

