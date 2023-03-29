'use strict'

const defaultFilter = () => true

const connectIpfsNodes = async (helia1, helia2, options = {
  filter: defaultFilter
}) => {
  await helia1.libp2p.peerStore.addressBook.set(helia2.libp2p.peerId, helia2.libp2p.getMultiaddrs().filter(options.filter))
  await helia1.libp2p.dial(helia2.libp2p.peerId)
}

export default connectIpfsNodes
