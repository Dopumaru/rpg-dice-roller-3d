# Dados 3D RPG

Sistema de rolagem de dados 3D para campanhas de RPG usando Three.js e cannon-es.

## Como rodar

1. Clone este repositório
2. Abra `dados-3d-rpg.html` diretamente no navegador
3. Não é necessário servidor nem npm — apenas um browser moderno

> Dica: use [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) no VS Code para melhor experiência.

## Funcionalidades

- Seletor de dados: d4, d6, d8, d10, d12, d20
- Física real: gravidade, colisão, torque, bordas e repouso (cannon-es)
- Parser de notação RPG: `2d6+3`, `1d20`, `4d6-2`
- Detecção de face vencedora no d6
- Interface dark mode inspirada na Biblioteca Digital RPG
- Tema claro/escuro com toggle
- Layout responsivo

## Stack

- **Renderização 3D**: Three.js v0.166
- **Física**: cannon-es v0.20
- **Fontes**: Cinzel, EB Garamond, Inter

## Próximos passos

- [ ] Texturas e números nas faces de cada dado
- [ ] Detecção de face para d4, d8, d10, d12 e d20
- [ ] Histórico de rolagens e log de combate
- [ ] Modo sessão com múltiplos jogadores
- [ ] Integração com o fluxo do site bibliorpg.com