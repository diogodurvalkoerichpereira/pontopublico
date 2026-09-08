# Sprint 20 — migração histórica

EP20 entrega lotes, staging de até 5.000 linhas por chamada, janela de 15 anos, validação por linha, idempotência, diferenças de contagem/valor, checksum e fechamento condicionado à reconciliação. Os dados consolidados vão para arquivo histórico isolado, sem sobrescrever a folha operacional. Interface de acompanhamento: `/admin/migracao-historica`.
