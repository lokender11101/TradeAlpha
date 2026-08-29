sed -i '' '/reservationPrice  Decimal?/a\
  reservedMargin    Decimal?    @map("reserved_margin") @db.Decimal(19, 4)\
' apps/api/prisma/schema.prisma
