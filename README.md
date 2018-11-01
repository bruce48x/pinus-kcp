pinus-kcp
============

[![Build Status][1]][2]

[1]: https://api.travis-ci.org/leenjewel/node-kcp.svg?branch=master
[2]: https://travis-ci.org/leenjewel/node-kcp


[KCP Protocol](https://github.com/skywind3000/kcp) for [Pinus](https://github.com/node-pinus/pinus)

说明
============

[pomelo-kcp-x](https://github.com/bruce48x/pomelo-kcp) 的 TypeScript 版本

结合 [Pinus](https://github.com/node-pinus/pinus) 使用

====

修改了 [pomelo-kcp](https://www.npmjs.com/package/pomelo-kcp)

原本是所有连接共用一个 conv

改为根据客户端发来的消息的 conv 创建对应的 kcpsocket 对象

方便跟 tcp 连接相互配合着使用，参见 [kcp 的 wiki](https://github.com/skywind3000/kcp/wiki/Cooperate-With-Tcp-Server)

====

另外修复了若干BUG，提高性能和稳定性，欢迎使用和提建议。
