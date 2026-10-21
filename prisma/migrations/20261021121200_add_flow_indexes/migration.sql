-- CreateIndex
CREATE INDEX "Flow_bookId_day_idx" ON "Flow"("bookId", "day");

-- CreateIndex
CREATE INDEX "Flow_bookId_day_money_idx" ON "Flow"("bookId", "day", "money" DESC);

-- CreateIndex
CREATE INDEX "Flow_bookId_flowType_idx" ON "Flow"("bookId", "flowType");
