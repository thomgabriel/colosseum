import type { Closed } from '../en/closed';

// A página de cofres encerrados em português do Brasil: as mesmas chaves de en/closed.ts.

export const closed: Closed = {
  label: 'Cofres encerrados',
  title: 'Cofres encerrados.',
  lead: 'Os cofres que você encerrou. Cada um fica no seu endereço na rede, vazio, e fora de todos os seus totais. Abra um de novo para tê-lo de volta no seu portfólio.',
  empty: 'Você não encerrou nenhum cofre.',
  link: (n: number) => `Cofres encerrados (${n})`,
  caption: 'Seus cofres encerrados',
  columns: { vault: 'Cofre', chain: 'Rede', closed: 'Encerrado', action: 'Abrir de novo' },
  reopen: 'Reabrir',
  reopening: 'Abrindo…',
  reopened: 'Aberto de novo: ele está de volta no seu portfólio.',
  failed: 'Não consegui abri-lo de novo: nosso servidor não respondeu. Tente de novo.',
  back: 'Voltar à visão geral',
};
