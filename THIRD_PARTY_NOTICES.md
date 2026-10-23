# Third-party notices

This integration ports to JavaScript the knowledge of the Tailwind local API
held by the following project: the `POST /json` requests and their bodies
(`dev_st`, `door_op`, `status_led`), the `TOKEN` header, the `result` words
(`OK`, `Fail`, `token fail`), the status fields (`dev_id` and its conversion
to a MAC address, `fw_ver`, `product`, `led_brightness`, the doors with
`index`, `status`, `lockup`, `disabled`), the minimum firmware 10.10 and the
checks made before a door command (locked out, disabled, already in the
state asked). No file is copied, and nothing of it is installed at runtime;
its notice is reproduced below as required by its license.

## gotailwind (python-gotailwind)

<https://github.com/frenck/python-gotailwind>, version 0.4.0

```
MIT License

Copyright (c) 2023-2026 Franck Nijhof

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LM1LC3N7/gladys-opengarage, gladys-blebox and gladys-ikea

The structure of the integration, `src/publisher.js` (from gladys-ikea,
through gladys-mystrom, gladys-blebox and gladys-opengarage),
`src/tailwind/http.js` (adapted from gladys-opengarage and gladys-blebox) and
`scripts/cover.mjs` come from integrations of the same author, under the
Apache License 2.0 of this repository.
