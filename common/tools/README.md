# ADB 运行工具

本源码准备版不包含原来的 ADB ZIP。原 ZIP 缺完整来源和随附许可，不能仅用项目 Apache-2.0 声明覆盖可执行文件及内嵌库。

开发态可使用目标机器上可信来源的系统 adb，并显式设置 ADB_BIN。平台打包脚本目前仍依赖两个架构 ZIP，需补齐许可完整制品并验证后才能构建正式安装包。
官方工具入口：https://developer.android.com/tools/releases/platform-tools 。请核实目标架构，不能假定官方 Linux 包支持所有 ARM 设备。
