sed -i '' '/await tx.orderFill.update({/,/});/d' apps/api/src/services/order.service.ts
sed -i '' '312a\
        await tx.orderFill.update({\
          where: { id: fill.id },\
          data: { realizedPnl: fillRealizedPnl }\
        });\
' apps/api/src/services/order.service.ts
