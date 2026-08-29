sed -i '' '/marginLevel = equity.dividedBy(maintenanceMargin).mul(100).toFixed(4);/c\
      const ml = equity.dividedBy(maintenanceMargin).mul(100);\
      marginLevel = ml.toFixed(4);\
      if (ml.lt(120)) marginStatus = "MARGIN_CALL";\
' apps/api/src/services/portfolio-valuation.service.ts
sed -i '' '/let marginLevel: string | null = null;/c\
    let marginLevel: string | null = null;\
    let marginStatus: "NORMAL" | "MARGIN_CALL" = "NORMAL";\
' apps/api/src/services/portfolio-valuation.service.ts
sed -i '' '/buyingPower: buyingPower.toFixed(4),/c\
      buyingPower: buyingPower.toFixed(4),\
      marginStatus,\
' apps/api/src/services/portfolio-valuation.service.ts
