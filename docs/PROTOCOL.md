# Протокол ZX Sync LED Strip (Robobloq SyncLight)

Восстановлен из SyncLight 2.22.1 (`resources/app.asar`, модули webpack 5786, 51545, 60895, 90337).

## Транспорт

- USB HID, `VID 0x1A86` / `PID 0xFE07`, интерфейс 0, manufacturer `ROBOBLOQ`.
- Пакет режется на куски по 64 байта; к каждому куску спереди добавляется report ID `0x00`.
- Ответы приходят HID input-репортами; ответ на команду имеет тот же байт ID (смещение 3 у `RB`).
- `ID` пакета — счётчик 1..254, увеличивается на каждую команду.
- `CS` — сумма всех предыдущих байтов пакета `mod 256`.

## Формат «RB» (обычные команды)

```
'R' 'B' LEN ID ACTION [payload...] CS
```
`LEN` — полная длина пакета (включая CS).

| ACTION | Имя                | Payload                         |
|-------:|--------------------|---------------------------------|
| 0x82   | readDeviceInfo     | — (ответ: id [5..7], displaySize [8], lamps [11], uuid [12..19], version [21..23]) |
| 0x83   | readDeviceUUID     | — (ответ: uuid [5..12])         |
| 0x86   | setSectionLED      | N × (start, R, G, B, end)       |
| 0x85   | setLedEffect       | effect, param                   |
| 0x87   | setBrightness      | 0..100                          |
| 0x8A   | setDynamicSpeed    | speed                           |
| 0x8B   | setSoundSensitivity| value                           |
| 0x89   | setAutoOff         | a, b                            |
| 0x93   | setOpenUrl         | flag                            |
| 0x95   | setLampsAmount     | count                           |
| 0x96   | setWhiteBright     | a, b                            |
| 0x97   | turnOffLight       | —                               |
| 0x98   | setComputerRhythm  | a, b                            |

## Формат «SC» (кадр Ambilight, прошивка > 1.0.2)

```
'S' 'C' LEN_HI LEN_LO ID 0x80 N × (start, R, G, B, end) CS
```
`LEN` — 16 бит big-endian, полная длина пакета.

Сегмент `(start, R, G, B, end)` красит светодиоды с `start` по `end` включительно,
нумерация с 1. Для прошивок ≤ 1.0.2 SyncLight шлёт то же самое через `setSectionLED`
кусками по 11 сегментов (55 байт) с паузой 20 мс.
